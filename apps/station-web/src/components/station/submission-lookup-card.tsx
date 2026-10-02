'use client'

/**
 * SubmissionLookupCard — the artist-facing half of the submissions pipeline.
 * Artists who already applied can check where their track sits (and grab their
 * rights ledger ID once one is issued) by looking up the exact email they
 * submitted with. Public by design: the API only returns status facts and is
 * rate-limited, so this can't enumerate emails or expose review notes.
 */

import { useCallback, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CheckCircle2,
  Clock3,
  Loader2,
  MailSearch,
  Radio,
  Search,
  X,
} from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ErrorLine } from '@/components/station/error-line'
import type { SubmissionLookupEntry, SubmissionLookupResponse } from '@/lib/station-types'
import { cn } from '@/lib/utils'

const STATUS_META: Record<
  SubmissionLookupEntry['status'],
  { label: string; hint: string; cls: string; Icon: typeof Clock3 }
> = {
  PENDING: {
    label: 'In the inbox',
    hint: 'Waiting for the A&R desk to open it — usually a couple of days.',
    cls: 'border-amber-500/40 bg-amber-500/10 text-amber-400',
    Icon: Clock3,
  },
  IN_REVIEW: {
    label: 'In review',
    hint: 'The desk is listening — rights screening comes next.',
    cls: 'border-primary/40 bg-primary/10 text-primary',
    Icon: Search,
  },
  APPROVED: {
    label: 'Approved',
    hint: 'Accepted — once the file lands and the rights record clears, the R-ID below goes on the wheel.',
    cls: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400',
    Icon: CheckCircle2,
  },
  DECLINED: {
    label: 'Declined',
    hint: 'Not a fit for rotation right now — you can submit different work anytime.',
    cls: 'border-red-500/40 bg-red-500/10 text-red-400',
    Icon: X,
  },
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
}

export function SubmissionLookupCard() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rows, setRows] = useState<SubmissionLookupEntry[] | null>(null)
  const [searchedFor, setSearchedFor] = useState('')

  const runLookup = useCallback(async () => {
    const value = email.trim()
    if (!value) {
      setError('Enter the email you submitted with.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/submissions/lookup?email=${encodeURIComponent(value)}`, {
        cache: 'no-store',
      })
      const body = (await res.json().catch(() => null)) as
        | (SubmissionLookupResponse & { error?: string })
        | null
      if (!res.ok) {
        setError(body?.error ?? `Lookup failed (${res.status})`)
        setRows(null)
        return
      }
      setRows(body?.submissions ?? [])
      setSearchedFor(value)
    } catch {
      setError('Network error — the lookup did not run.')
    } finally {
      setLoading(false)
    }
  }, [email])

  return (
    <Card className="border-border/60 bg-card/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="rounded-md bg-primary/10 p-1.5 text-primary">
            <MailSearch className="h-4 w-4" aria-hidden />
          </div>
          Track your submission
        </CardTitle>
        <CardDescription>
          Already sent a track? Enter the exact email you submitted with — status only, nothing
          else leaves the studio.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault()
            void runLookup()
          }}
        >
          <label htmlFor="lookup-email" className="sr-only">
            The email you submitted with
          </label>
          <Input
            id="lookup-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-10 flex-1"
            aria-describedby={error ? 'lookup-error' : undefined}
          />
          <Button type="submit" className="h-10 sm:w-36" disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Search className="mr-2 h-4 w-4" aria-hidden />
            )}
            {loading ? 'Looking…' : 'Check status'}
          </Button>
        </form>

        {error && (
          <div id="lookup-error" role="alert">
            <ErrorLine message={error} />
          </div>
        )}

        {rows !== null && !error && (
          rows.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
              Nothing found for <span className="font-mono text-foreground/80">{searchedFor}</span>{' '}
              — double-check the address, or send your first track with the form above.
            </p>
          ) : (
            <ul className="space-y-2" aria-live="polite">
              {rows.map((row, idx) => {
                const meta = STATUS_META[row.status]
                return (
                  <motion.li
                    key={`${row.trackTitle}-${row.createdAt}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, delay: idx * 0.06, ease: 'easeOut' }}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-card/40 p-3 sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {row.trackTitle}
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {row.genre}
                        </span>
                      </p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        Submitted {fmtDate(row.createdAt)}
                        {row.reviewedAt ? ` · reviewed ${fmtDate(row.reviewedAt)}` : ''}
                      </p>
                      <p className="mt-1 text-[11px] leading-snug text-muted-foreground/80">
                        {meta.hint}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      {row.rightsId && (
                        <span
                          title="Rights ledger ID — issued once the track cleared"
                          className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-emerald-400"
                        >
                          <Radio className="h-2.5 w-2.5" aria-hidden />
                          {row.rightsId}
                        </span>
                      )}
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider',
                          meta.cls,
                        )}
                      >
                        <meta.Icon className="h-2.5 w-2.5" aria-hidden />
                        {meta.label}
                      </span>
                    </div>
                  </motion.li>
                )
              })}
            </ul>
          )
        )}
      </CardContent>
    </Card>
  )
}
