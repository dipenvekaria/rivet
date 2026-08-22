import Link from 'next/link'
import { PhoneIncoming } from 'lucide-react'

import { EmptyState } from '@/components/shared/empty-state'
import { PageContainer, PageHeader, Section } from '@/components/shared/page'
import { requireSession } from '@/lib/auth/session'
import { companyTz } from '@/lib/time'
import { query } from '@/lib/db'

import { CallRow } from './call-row'
import { VoiceSettingsCard } from './voice-settings-card'

export const metadata = { title: 'Calls' }
export const dynamic = 'force-dynamic'

/**
 * Every answered call: who, when, what they wanted, and the lead it became.
 * The transcript folds open per row — the summary is the working surface,
 * the transcript is the receipt.
 */
export default async function CallsPage() {
  const { companyId, role } = await requireSession()
  // Calls carry customer contact details and lead context — dispatch material,
  // same audience as the pipeline's money view.
  const canSee = role === 'owner' || role === 'office'

  const [company] = await query<{
    name: string
    voice_enabled: boolean
    voice_number: string | null
    settings: {
      timezone?: string
      voice?: { greeting?: string; notes?: string; transfer_number?: string }
    } | null
  }>(
    `select name, voice_enabled, voice_number, settings from companies where id = $1`,
    [companyId],
  )
  const tz = companyTz({ timezone: company?.settings?.timezone ?? null })
  const voiceSettings = company?.settings?.voice ?? {}

  const calls = canSee
    ? await query<{
        id: string
        from_number: string | null
        started_at: string | null
        duration_seconds: number | null
        summary: string | null
        transcript: string | null
        recording_url: string | null
        work_item_id: string | null
        customer_name: string | null
        job_name: string | null
        work_status: string | null
      }>(
        `select v.id, v.from_number, v.started_at, v.duration_seconds, v.summary,
                v.transcript, v.recording_url, v.work_item_id,
                c.name as customer_name, w.job_name, w.status as work_status
           from voice_calls v
           left join work_items w on w.id = v.work_item_id
           left join customers c on c.id = w.customer_id
          where v.company_id = $1
          order by v.started_at desc nulls last, v.created_at desc
          limit 200`,
        [companyId],
      )
    : []

  const pretty = company?.voice_number?.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '($1) $2-$3')

  return (
    <PageContainer>
      <PageHeader
        title="Calls"
        description={
          company?.voice_enabled && pretty
            ? `Answered on ${pretty}. Every call becomes a lead with the transcript kept.`
            : 'Calls answered for you, with transcripts, once call answering is on.'
        }
      />
      {!canSee ? (
        <p className="mt-6 text-sm text-muted-foreground">
          Call records are visible to the owner and office.
        </p>
      ) : !company?.voice_enabled ? (
        <div className="mt-6">
          <EmptyState
            icon={PhoneIncoming}
            title="Call answering is off"
            description="Turn it on and a local number answers when you can't — every call lands here and in your pipeline."
            action={
              <Link
                href="/app/integrations"
                className="inline-flex h-11 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm hover:opacity-90"
              >
                Set up call answering
              </Link>
            }
          />
        </div>
      ) : (
        <>
          {role === 'owner' && (
            <div className="mt-6">
              <VoiceSettingsCard
                greeting={voiceSettings.greeting ?? ''}
                notes={voiceSettings.notes ?? ''}
                transferNumber={voiceSettings.transfer_number ?? ''}
                companyName={company?.name ?? 'your company'}
              />
            </div>
          )}
          {calls.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            icon={PhoneIncoming}
            title="No calls yet"
            description={`When someone calls ${pretty ?? 'your number'}, the call and its transcript appear here.`}
          />
        </div>
          ) : (
            <Section className="mt-6" flush>
              <ul className="divide-y divide-border/70">
                {calls.map((call) => (
                  <CallRow key={call.id} call={call} tz={tz} />
                ))}
              </ul>
            </Section>
          )}
        </>
      )}
    </PageContainer>
  )
}
