'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

import { updateVoiceSettings } from './actions'

/**
 * The owner's voice: exactly how the assistant opens, any house instructions
 * ("ask if they're an existing customer"), and who to hand urgent callers to.
 * Prices stay structurally off-limits regardless of what is typed here.
 */
export function VoiceSettingsCard({
  greeting,
  notes,
  transferNumber,
  companyName,
}: {
  greeting: string
  notes: string
  transferNumber: string
  companyName: string
}) {
  const router = useRouter()
  const [g, setG] = useState(greeting)
  const [n, setN] = useState(notes)
  const [t, setT] = useState(transferNumber)
  const [busy, start] = useTransition()

  function save() {
    start(async () => {
      const res = await updateVoiceSettings({ greeting: g, notes: n, transfer_number: t })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success('Saved — the next call answers this way.')
      router.refresh()
    })
  }

  return (
    <section className="rounded-xl border border-border/70 bg-card p-5 shadow-sm">
      <h2 className="text-sm font-semibold">How it answers</h2>
      <div className="mt-4 space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="voice-greeting">Opening line</Label>
          <Input
            id="voice-greeting"
            value={g}
            onChange={(e) => setG(e.target.value)}
            maxLength={200}
            placeholder={`Thanks for calling ${companyName} — how can I help you today?`}
            className="h-11"
          />
          <p className="text-xs text-muted-foreground">
            Said word-for-word at pickup. Leave blank for the default.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="voice-notes">House instructions</Label>
          <Textarea
            id="voice-notes"
            value={n}
            onChange={(e) => setN(e.target.value)}
            maxLength={600}
            rows={3}
            placeholder="Ask early whether they're an existing customer or new. Mention we serve the whole metro."
          />
          <p className="text-xs text-muted-foreground">
            Extra questions or things to mention. It still never quotes prices or promises
            times, whatever is written here.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="voice-transfer">Transfer urgent callers to</Label>
          <Input
            id="voice-transfer"
            type="tel"
            value={t}
            onChange={(e) => setT(e.target.value)}
            placeholder="+15125550123"
            className="h-11 max-w-xs tabular"
          />
          <p className="text-xs text-muted-foreground">
            When someone needs a person right now, the assistant connects them live. Blank
            turns transfers off.
          </p>
        </div>
        <Button onClick={save} disabled={busy} className="h-11 gap-1.5 lg:h-9">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Save
        </Button>
      </div>
    </section>
  )
}
