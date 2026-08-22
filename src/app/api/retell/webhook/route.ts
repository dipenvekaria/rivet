import { createHmac, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'

import { logActivity } from '@/lib/activity'
import { query, withTransaction } from '@/lib/db'
import { envServer } from '@/lib/env'
import { notify, officeUserIds } from '@/lib/notifications'
import type { RetellCallEvent } from '@/lib/voice/retell'

export const dynamic = 'force-dynamic'

/**
 * Retell webhook: a finished, analyzed call becomes a lead in the pipeline —
 * the whole point of answering the phone. `call_analyzed` fires once per call
 * and carries the transcript and summary; everything else is acknowledged and
 * ignored. Idempotency rides on voice_calls.retell_call_id being unique.
 */
export async function POST(req: NextRequest) {
  const { RETELL_SECRET_WEBHOOK_KEY, RETELL_API_KEY } = envServer()
  const keys = [RETELL_SECRET_WEBHOOK_KEY, RETELL_API_KEY].filter((k): k is string => Boolean(k))
  if (keys.length === 0) return NextResponse.json({ error: 'not configured' }, { status: 503 })

  const raw = await req.text()
  // Retell signs v={unix_ms},d=hex(HMAC-SHA256(raw_body + timestamp, api_key)).
  // The first version of this route verified a bare digest of the body alone —
  // self-consistent with its own test, and 401 for every real call.
  const sig = req.headers.get('x-retell-signature') ?? ''
  const parsed = sig.match(/^v=(\d+),d=([a-f0-9]{64})$/)
  const fresh = parsed && Math.abs(Date.now() - Number(parsed[1])) < 5 * 60_000
  const ok =
    Boolean(parsed && fresh) &&
    keys.some((key) => {
      const expected = createHmac('sha256', key).update(raw + parsed![1]).digest('hex')
      return timingSafeEqual(Buffer.from(parsed![2]), Buffer.from(expected))
    })
  if (!ok) {
    // Loud on purpose: a scheme mismatch here must surface on the first real
    // call, not read as "voice silently does nothing".
    console.error('retell webhook signature rejected', parsed ? 'digest/replay' : 'format')
    return NextResponse.json({ error: 'bad signature' }, { status: 401 })
  }

  let event: RetellCallEvent
  try {
    event = JSON.parse(raw) as RetellCallEvent
  } catch {
    return NextResponse.json({ error: 'bad payload' }, { status: 400 })
  }

  if (event.event !== 'call_analyzed') return NextResponse.json({ received: true })

  const call = event.call
  if (!call?.call_id || !call.to_number) return NextResponse.json({ received: true })

  const [company] = await query<{ id: string; name: string }>(
    `select id, name from companies where voice_number = $1 and voice_enabled limit 1`,
    [call.to_number],
  )
  if (!company) {
    console.error('retell call for unknown number', call.to_number)
    return NextResponse.json({ received: true })
  }

  const from = call.from_number ?? null
  const summary =
    call.call_analysis?.call_summary?.trim() ||
    'Call answered — no summary was produced. Read the transcript on the call record.'

  const leadId = await withTransaction(async (q) => {
    // One row per Retell call, ever — replays and retries stop here.
    const inserted = await q<{ id: string }>(
      `insert into voice_calls
         (company_id, retell_call_id, from_number, to_number, started_at, duration_seconds,
          summary, transcript, recording_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (retell_call_id) do nothing
       returning id`,
      [
        company.id,
        call.call_id,
        from,
        call.to_number,
        call.start_timestamp ? new Date(call.start_timestamp).toISOString() : null,
        call.duration_ms ? Math.round(call.duration_ms / 1000) : null,
        summary,
        call.transcript ?? null,
        call.recording_url ?? null,
      ],
    )
    if (!inserted[0]) return null

    // The caller, by phone number — the one identity a phone call guarantees.
    let customerId: string | null = null
    const fromDigits = from?.replace(/\D/g, '').slice(-10) ?? ''
    if (fromDigits.length === 10) {
      // Digits, not strings: the caller arrives as +15125550198 and the book
      // may say (512) 555-0198 — the same phone either way.
      const [existing] = await q<{ id: string }>(
        `select id from customers
          where company_id = $1
            and right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10) = $2
          order by created_at asc limit 1`,
        [company.id, fromDigits],
      )
      customerId = existing?.id ?? null
    }
    if (!customerId) {
      const label = from ? `Caller ${from}` : 'Caller (number withheld)'
      const [made] = await q<{ id: string }>(
        `insert into customers (company_id, name, phone) values ($1, $2, $3) returning id`,
        [company.id, label, from],
      )
      customerId = made.id
    }

    const [lead] = await q<{ id: string }>(
      `insert into work_items (company_id, customer_id, description, status)
       values ($1, $2, $3, 'lead'::work_item_status)
       returning id`,
      [company.id, customerId, summary],
    )
    await q(`update voice_calls set work_item_id = $2 where retell_call_id = $1`, [
      call.call_id,
      lead.id,
    ])
    return lead.id
  })

  if (leadId) {
    await logActivity({
      companyId: company.id,
      entityId: leadId,
      action: 'lead_created',
      description: `Call answered${from ? ` from ${from}` : ''} — lead captured`,
    })
    await notify({
      companyId: company.id,
      userIds: await officeUserIds(company.id),
      kind: 'voice_lead',
      title: 'The assistant answered a call',
      body: summary.length > 140 ? `${summary.slice(0, 137)}…` : summary,
      href: `/app/pipeline/${leadId}`,
    })
  }

  return NextResponse.json({ received: true })
}
