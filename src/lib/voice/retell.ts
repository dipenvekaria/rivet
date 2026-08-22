/**
 * Retell — the AI that answers the phone.
 *
 * Retell is transport and voice; the brain it runs is Gemini, per the house
 * model rule. Each company gets its own agent (so the greeting carries their
 * name, not ours) bound to their own number. Everything here fails loud and
 * null-free: voice being unconfigured must read as "not set up", never as a
 * silent no-op behind a working-looking switch.
 */

import { env, envServer } from '@/lib/env'

const BASE = 'https://api.retellai.com'

/**
 * Gemini, as Retell names it. Their catalog moves; if creation ever rejects
 * this id, the fix is this constant — never a swap to a non-Google model.
 */
const RETELL_GEMINI_MODEL = 'gemini-2.0-flash'

export function voiceConfigured(): boolean {
  return Boolean(envServer().RETELL_API_KEY)
}

async function retell<T>(path: string, init?: RequestInit): Promise<T> {
  const key = envServer().RETELL_API_KEY
  if (!key) throw new Error('RETELL_API_KEY is not set')
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Retell ${path} failed: ${res.status} ${body.slice(0, 300)}`)
  }
  return (await res.json()) as T
}

/**
 * The agent's instructions. Deliberately trade-agnostic: it answers for a
 * hundred different trades, so it grounds itself in the company's own name
 * and words and never assumes the work. It books the callback; it does not
 * quote, promise times, or invent prices.
 */
function agentPrompt(companyName: string, trade: string | null): string {
  const who = trade ? `${companyName}, a ${trade} company` : companyName
  return `You answer the phone for ${who}. You are their scheduling assistant — warm, brief, and professional.

Your one job: capture the caller's request so the team can call back with next steps.

Collect, conversationally:
1. Their name.
2. The service address (street, city).
3. What they need, in their own words — let them describe it; ask one clarifying question if it is vague.
4. How urgent it is, and any preferred days or times.

Rules:
- Never quote prices, give estimates, or promise a specific appointment time. Say the team will confirm details when they call back.
- Never claim a person is available right now.
- If it is an emergency involving immediate danger (gas smell, major flooding, sparks), tell them to hang up and call emergency services or their utility first.
- Keep replies to one or two sentences. No filler.
- Close by confirming their name and address back to them and saying ${companyName} will follow up shortly.`
}

export type RetellAgent = { agent_id: string; llm_id: string }

/**
 * One company's agent: a Retell LLM (the Gemini brain + prompt) and the agent
 * shell around it. Returns ids to store on the company row.
 */
export async function createCompanyAgent(companyName: string, trade: string | null): Promise<RetellAgent> {
  const llm = await retell<{ llm_id: string }>('/create-retell-llm', {
    method: 'POST',
    body: JSON.stringify({
      model: RETELL_GEMINI_MODEL,
      general_prompt: agentPrompt(companyName, trade),
    }),
  })

  const agent = await retell<{ agent_id: string }>('/create-agent', {
    method: 'POST',
    body: JSON.stringify({
      agent_name: `${companyName} — Rivet answering`,
      response_engine: { type: 'retell-llm', llm_id: llm.llm_id },
      voice_id: '11labs-Adrian',
      language: 'en-US',
      enable_backchannel: true,
      webhook_url: `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')}/api/retell/webhook`,
    }),
  })

  return { agent_id: agent.agent_id, llm_id: llm.llm_id }
}

/**
 * Buy a local number and bind it in one call — the contractor toggles the
 * service on and never learns what telephony is. ~$2/mo, billed to the
 * platform's Retell account.
 */
export async function purchaseNumber(
  agentId: string,
  nickname: string,
  preferredAreaCode: number | null,
): Promise<string> {
  const buy = (areaCode: number | null) =>
    retell<{ phone_number: string }>('/create-phone-number', {
      method: 'POST',
      body: JSON.stringify({
        ...(areaCode ? { area_code: areaCode } : {}),
        inbound_agents: [{ agent_id: agentId, weight: 1 }],
        nickname,
      }),
    })

  if (preferredAreaCode) {
    try {
      return (await buy(preferredAreaCode)).phone_number
    } catch (e) {
      const msg = e instanceof Error ? e.message : ''
      // Sold-out area code → any number, silently: callers dial the company's
      // own line and never see this one, so local is a preference, not a
      // requirement. Owner decision. Anything else still fails loud.
      if (!msg.includes('No phone numbers of this area code')) throw e
      console.log(`purchaseNumber: area code ${preferredAreaCode} sold out, buying any`)
    }
  }
  return (await buy(null)).phone_number
}

export type RetellCallEvent = {
  event: string
  call: {
    call_id: string
    agent_id?: string
    from_number?: string
    to_number?: string
    start_timestamp?: number
    duration_ms?: number
    transcript?: string
    recording_url?: string
    call_analysis?: { call_summary?: string }
  }
}
