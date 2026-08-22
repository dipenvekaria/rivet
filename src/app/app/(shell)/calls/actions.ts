'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { getSession } from '@/lib/auth/session'
import { query } from '@/lib/db'

const voiceSettingsSchema = z.object({
  greeting: z.string().trim().max(200).optional().default(''),
  notes: z.string().trim().max(600).optional().default(''),
  transfer_number: z
    .string()
    .trim()
    .regex(/^\+1\d{10}$/, 'Use the full number with country code, like +15125550123.')
    .or(z.literal(''))
    .optional()
    .default(''),
})

/**
 * The owner's knobs on how the assistant answers: the exact opening line,
 * house instructions, and a live-transfer number. Saving re-syncs the live
 * Retell agent so edits apply to the next call, not the next signup.
 */
export async function updateVoiceSettings(input: unknown) {
  const parsed = voiceSettingsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false as const, error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const session = await getSession()
  if (!session) return { ok: false as const, error: 'Not authenticated' }
  if (session.role !== 'owner') {
    return { ok: false as const, error: 'Only the owner can change how calls are answered.' }
  }

  const voice = {
    greeting: parsed.data.greeting || null,
    notes: parsed.data.notes || null,
    transfer_number: parsed.data.transfer_number || null,
  }
  await query(
    `update companies
        set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{voice}', $2::jsonb)
      where id = $1`,
    [session.companyId, JSON.stringify(voice)],
  )

  // Push to the live agent. A Retell failure keeps the saved settings — the
  // next save or enable retries — but the owner hears about it.
  const [company] = await query<{ retell_agent_id: string | null }>(
    `select retell_agent_id from companies where id = $1`,
    [session.companyId],
  )
  if (company?.retell_agent_id) {
    try {
      const [{ refreshCompanyAgent }, { loadAgentCompany }] = await Promise.all([
        import('@/lib/voice/retell'),
        import('@/lib/voice/company'),
      ])
      const agentCompany = await loadAgentCompany(session.companyId)
      if (agentCompany) await refreshCompanyAgent(company.retell_agent_id, agentCompany)
    } catch (e) {
      console.error('voice settings agent refresh failed', e)
      return {
        ok: false as const,
        error: 'Saved, but the live agent could not be updated — try saving again.',
      }
    }
  }

  revalidatePath('/app/calls')
  return { ok: true as const }
}
