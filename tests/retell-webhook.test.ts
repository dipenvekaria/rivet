import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { query } from '@/lib/db'

/**
 * The webhook is the whole voice feature from Rivet's side: a signed
 * call_analyzed event must become exactly one lead, with the transcript kept
 * and a replay changing nothing.
 */

const SIGNING_KEY = 'dummy-signing-key-for-tests'
const NUMBER = '+15559990000'
const CALLER = '+15551230000'
let companyId: string

function signedRequest(body: unknown, opts?: { staleMs?: number }): NextRequest {
  const raw = JSON.stringify(body)
  // The real Retell scheme: v={unix_ms},d=hmac(raw+timestamp). The first
  // version of this test signed a bare body digest — it validated the route
  // against itself while production 401'd every genuine call.
  const ts = String(Date.now() - (opts?.staleMs ?? 0))
  const digest = createHmac('sha256', SIGNING_KEY).update(raw + ts).digest('hex')
  return new NextRequest('http://localhost/api/retell/webhook', {
    method: 'POST',
    body: raw,
    headers: { 'x-retell-signature': `v=${ts},d=${digest}` },
  })
}

const event = (callId: string) => ({
  event: 'call_analyzed',
  call: {
    call_id: callId,
    from_number: CALLER,
    to_number: NUMBER,
    start_timestamp: Date.now(),
    duration_ms: 154_000,
    transcript: 'Agent: Thanks for calling…\nCaller: My water heater is leaking…',
    call_analysis: { call_summary: 'Water heater leaking in the garage; wants someone this week.' },
  },
})

beforeAll(async () => {
  process.env.RETELL_SECRET_WEBHOOK_KEY = SIGNING_KEY
  // A company of our own: the shared demo row races other test files that
  // mutate companies in parallel, which made this suite flake.
  const [co] = await query<{ id: string }>(
    `insert into companies (name, voice_enabled, voice_number)
     values ('Webhook Test Co', true, $1)
     returning id`,
    [NUMBER],
  )
  companyId = co.id
})

afterAll(async () => {
  await query(`delete from work_items where company_id = $1`, [companyId])
  await query(`delete from voice_calls where company_id = $1`, [companyId])
  await query(`delete from customers where company_id = $1`, [companyId])
  await query(`delete from companies where id = $1`, [companyId])
})

describe('retell webhook', () => {
  it('rejects a stale timestamp (replay)', async () => {
    const { POST } = await import('@/app/api/retell/webhook/route')
    const res = await POST(signedRequest(event('test_call_replay'), { staleMs: 6 * 60_000 }))
    expect(res.status).toBe(401)
  })

  it('rejects a bad signature', async () => {
    const { POST } = await import('@/app/api/retell/webhook/route')
    const raw = JSON.stringify(event('test_call_sig'))
    const req = new NextRequest('http://localhost/api/retell/webhook', {
      method: 'POST',
      body: raw,
      headers: { 'x-retell-signature': 'deadbeef' },
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })

  it('turns an analyzed call into one lead, idempotently', async () => {
    const { POST } = await import('@/app/api/retell/webhook/route')

    const res1 = await POST(signedRequest(event('test_call_1')))
    expect(res1.status).toBe(200)

    const [call] = await query<{ work_item_id: string | null; transcript: string | null }>(
      `select work_item_id, transcript from voice_calls where retell_call_id = 'test_call_1'`,
    )
    expect(call?.work_item_id).toBeTruthy()
    expect(call?.transcript).toContain('water heater')

    const [lead] = await query<{ status: string; description: string | null }>(
      `select status, description from work_items where id = $1 and company_id = $2`,
      [call.work_item_id, companyId],
    )
    expect(lead?.status).toBe('lead')
    expect(lead?.description).toContain('Water heater leaking')

    // Replay: same call id, nothing new.
    const before = await query<{ n: number }>(
      `select count(*)::int as n from work_items where company_id = $1`,
      [companyId],
    )
    const res2 = await POST(signedRequest(event('test_call_1')))
    expect(res2.status).toBe(200)
    const after = await query<{ n: number }>(
      `select count(*)::int as n from work_items where company_id = $1`,
      [companyId],
    )
    expect(after[0].n).toBe(before[0].n)
  })
})
