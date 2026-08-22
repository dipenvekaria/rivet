'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getSession } from '@/lib/auth/session'
import { query } from '@/lib/db'

const passCardFeesSchema = z.object({ pass_card_fees: z.boolean() })

/**
 * The checkbox on the Stripe card. The old UI POSTed to an API route that
 * was never written — a dead control toasting "Could not save preference."
 */
export async function setPassCardFees(input: z.infer<typeof passCardFeesSchema>) {
  const parsed = passCardFeesSchema.safeParse(input)
  if (!parsed.success) return { ok: false as const, error: 'Invalid input' }

  const session = await getSession()
  if (!session) return { ok: false as const, error: 'Not authenticated' }
  if (session.role !== 'owner') {
    return { ok: false as const, error: 'Only owners and admins can change payment settings.' }
  }

  await query('update companies set pass_card_fees = $1 where id = $2', [
    parsed.data.pass_card_fees,
    session.companyId,
  ])
  revalidatePath('/app/integrations')
  return { ok: true as const }
}




/**
 * Turns on call answering for this company: creates their Retell agent
 * (Gemini-backed, greeting in their name) and points the number's inbound
 * calls at it. The number must already be imported into Retell — the card
 * explains that; binding an unknown number fails loudly here.
 */
export async function enableVoice() {
  const session = await getSession()
  if (!session) return { ok: false as const, error: 'Not authenticated' }
  if (session.role !== 'owner') {
    return { ok: false as const, error: 'Only the owner can set up call answering.' }
  }

  const { voiceConfigured, createCompanyAgent, refreshCompanyAgent, purchaseNumber } = await import('@/lib/voice/retell')
  if (!voiceConfigured()) {
    return { ok: false as const, error: 'Call answering is not configured on the platform yet.' }
  }

  const [company] = await query<{ name: string; phone: string | null; email: string | null; retell_agent_id: string | null }>(
    `select name, phone, email, retell_agent_id from companies where id = $1 limit 1`,
    [session.companyId],
  )
  if (!company) return { ok: false as const, error: 'Company not found' }

  const { loadAgentCompany } = await import('@/lib/voice/company')
  const agentCompany = await loadAgentCompany(session.companyId)
  if (!agentCompany) return { ok: false as const, error: 'Company not found' }

  let number: string
  try {
    let agentId = company.retell_agent_id
    if (!agentId) {
      agentId = (await createCompanyAgent(agentCompany)).agent_id
      // Persisted before the number step: a failure there must not strand the
      // agent in Retell and mint a duplicate on every retry (it did).
      await query(`update companies set retell_agent_id = $2 where id = $1`, [
        session.companyId,
        agentId,
      ])
    } else {
      // Re-enabling refreshes an old agent's prompt and voice — agents are
      // not frozen at whatever the code did the day they were created.
      await refreshCompanyAgent(agentId, agentCompany)
    }

    // Their own area code when Retell stocks it, any number when not — the
    // contractor is never asked either way.
    const digits = company.phone?.replace(/\D/g, '').replace(/^1/, '').slice(0, 3)
    const preferred = digits && /^\d{3}$/.test(digits) ? Number(digits) : null
    number = await purchaseNumber(agentId, `${company.name} — Rivet answering`, preferred)

    await query(
      `update companies set voice_enabled = true, voice_number = $2 where id = $1`,
      [session.companyId, number],
    )
  } catch (e) {
    console.error('enableVoice failed', e)
    const detail = e instanceof Error ? e.message.slice(0, 200) : ''
    return {
      ok: false as const,
      // The real rejection, not a guess — the fixed message sent the owner
      // hunting an import problem that did not exist.
      error: detail ? `Setup failed: ${detail}` : 'Setup failed — try again.',
    }
  }

  // Best-effort: the number and how to connect it, in their inbox for the
  // office and the truck. Failure here never rolls back a working setup.
  try {
    const { sendVoiceLiveEmail } = await import('@/lib/email/senders')
    const to = session.email || company.email
    if (to) await sendVoiceLiveEmail({ to, companyName: company.name, number })
  } catch (e) {
    console.error('voice live email failed', e)
  }

  revalidatePath('/app/integrations')
  return { ok: true as const, data: { number } }
}
