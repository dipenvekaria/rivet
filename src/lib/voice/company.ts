import { query } from '@/lib/db'

import type { AgentCompany } from './retell'

/**
 * Everything the agent may know about one company, assembled in one place so
 * enabling and later editing produce the identical agent. Catalog item names
 * only — what the company does, never what it charges.
 */
export async function loadAgentCompany(companyId: string): Promise<AgentCompany | null> {
  const [company] = await query<{
    name: string
    trade: string | null
    address: string | null
    settings: { voice?: { greeting?: string; notes?: string; transfer_number?: string } } | null
  }>(
    `select name, trade, address, settings from companies where id = $1 limit 1`,
    [companyId],
  )
  if (!company) return null

  const serviceRows = await query<{ name: string }>(
    `select name from catalog_items where company_id = $1 and coalesce(is_active, true)
      order by name limit 15`,
    [companyId],
  )
  const area = company.address?.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\b/)
  const voice = company.settings?.voice ?? {}
  return {
    name: company.name,
    trade: company.trade,
    area: area ? `${area[1].trim()}, ${area[2]}` : null,
    services: serviceRows.map((r) => r.name),
    greeting: voice.greeting?.trim() || null,
    notes: voice.notes?.trim() || null,
    transferNumber: voice.transfer_number?.trim() || null,
  }
}
