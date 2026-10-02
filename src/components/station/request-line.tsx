'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Flame,
  ListMusic,
  MessageSquareQuote,
  Radio,
  Search,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from 'sonner'
import type {
  RequestsResponse,
  TrackRequestResponse,
  TracksResponse,
} from '@/lib/station-types'
import { cn } from '@/lib/utils'

const NAME_KEY = 'wavc-onair-name'
/** Cross-component event: pre-select a track in the picker (from the track dialog). */
export const REQUEST_PREFILL_EVENT = 'wavc:prefill-request'

function timeAgo(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hr ago`
  return `${Math.round(hrs / 24)} d ago`
}

/**
 * RequestLine — listeners shout for the next spin. The rights gate applies
 * here too: the picker only ever lists CLEARED tracks (see /api/tracks).
 */
export function RequestLine() {
  const [tracks, setTracks] = useState<TracksResponse['tracks'] | null>(null)
  const [requests, setRequests] = useState<RequestsResponse | null>(null)
  const [feedError, setFeedError] = useState(false)
  const [query, setQuery] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [selected, setSelected] = useState<TracksResponse['tracks'][number] | null>(null)
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const pendingTrackRef = useRef<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = async () => {
    try {
      const [reqRes, trkRes] = await Promise.all([
        fetch('/api/requests', { cache: 'no-store' }),
        fetch('/api/tracks', { cache: 'no-store' }),
      ])
      if (!reqRes.ok || !trkRes.ok) throw new Error('feed')
      setRequests((await reqRes.json()) as RequestsResponse)
      setTracks((await trkRes.json()).tracks)
      setFeedError(false)
    } catch {
      setFeedError(true)
    }
  }

  useEffect(() => {
    refresh()
    try {
      setName(localStorage.getItem(NAME_KEY) ?? '')
    } catch {
      /* private mode */
    }
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])

  // Apply a prefill that arrived before the library finished loading.
  useEffect(() => {
    if (!tracks || !pendingTrackRef.current) return
    const wanted = pendingTrackRef.current
    const t = tracks.find((x) => x.id === wanted)
    if (t) setSelected(t)
    pendingTrackRef.current = null
  }, [tracks])

  // Other surfaces (track dialog, up-next, history) can prefill a request.
  useEffect(() => {
    const onPrefill = (e: Event) => {
      const detail = (e as CustomEvent<{ trackId?: string }>).detail
      const trackId = detail?.trackId
      if (!trackId) return
      if (tracks) {
        const t = tracks.find((x) => x.id === trackId)
        if (t) setSelected(t)
      } else {
        pendingTrackRef.current = trackId
      }
      setPickerOpen(false)
    }
    window.addEventListener(REQUEST_PREFILL_EVENT, onPrefill)
    return () => window.removeEventListener(REQUEST_PREFILL_EVENT, onPrefill)
  }, [tracks])

  // close the picker on outside click
  useEffect(() => {
    if (!pickerOpen) return
    const onDoc = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [pickerOpen])

  const filtered = useMemo(() => {
    if (!tracks) return []
    const q = query.trim().toLowerCase()
    const base = q
      ? tracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q),
        )
      : tracks
    return base.slice(0, 7)
  }, [tracks, query])

  const submit = async () => {
    if (!selected || !name.trim() || submitting) return
    setSubmitting(true)
    try {
      const res = await fetch('/api/requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trackId: selected.id,
          listenerName: name.trim(),
          note: note.trim() || null,
        }),
      })
      const data = (await res.json()) as TrackRequestResponse | { error: string }
      if (!res.ok || 'error' in data) {
        toast.error('error' in data ? data.error : 'Request failed')
        return
      }
      toast.success(data.message)
      try {
        localStorage.setItem(NAME_KEY, name.trim())
      } catch {
        /* private mode */
      }
      setNote('')
      setQuery('')
      setSelected(null)
      await refresh()
    } catch {
      toast.error('Request line is down — try again shortly.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section id="request-line" aria-label="Request line" className="relative scroll-mt-20">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <span className="rounded-lg bg-primary/10 p-2 text-primary">
          <Flame className="h-5 w-5" aria-hidden="true" />
        </span>
        <div>
          <h2 className="text-xl font-bold tracking-tight">Request Line</h2>
          <p className="text-sm text-muted-foreground">
            Shout for the next spin — cleared tracks only, the gate checks every request.
          </p>
        </div>
        {requests && (
          <Badge
            variant="outline"
            className="ml-auto border-primary/40 bg-primary/10 text-primary"
          >
            {requests.totalToday} requests today
          </Badge>
        )}
      </div>

      {feedError ? (
        <div className="rounded-xl border border-border/60 bg-card/60 p-6 text-sm text-muted-foreground">
          Request line unavailable —{' '}
          <button
            onClick={refresh}
            className="text-primary underline-offset-4 hover:underline"
          >
            retry
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* ---- request composer ---- */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25 }}
            className="card-glow flex h-full flex-col rounded-xl border border-border/60 bg-card/60 p-4 sm:p-5"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <Radio className="h-4 w-4 text-primary" aria-hidden="true" />
              Shout for a spin
            </div>

            {/* track picker */}
            <div ref={pickerRef} className="relative mb-3">
              {selected ? (
                <div className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 truncate text-sm font-medium">
                      {selected.explicit && (
                        <span className="rounded bg-red-500/20 px-1 text-[10px] font-bold text-red-400">
                          E
                        </span>
                      )}
                      <span className="truncate">{selected.title}</span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        — {selected.artist}
                      </span>
                    </div>
                  </div>
                  <button
                    aria-label="Clear selected track"
                    onClick={() => setSelected(null)}
                    className="ml-2 rounded p-1 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                <>
                  <div className="relative">
                    <Search
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <Input
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value)
                        setPickerOpen(true)
                      }}
                      onFocus={() => setPickerOpen(true)}
                      placeholder="Search the cleared library…"
                      aria-label="Search tracks to request"
                      className="pl-9"
                    />
                  </div>
                  {pickerOpen && (
                    <div
                      role="listbox"
                      aria-label="Track results"
                      className="scrollbar-thin absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl"
                    >
                      {!tracks ? (
                        <div className="space-y-1.5 p-2">
                          <Skeleton className="h-8 w-full" />
                          <Skeleton className="h-8 w-full" />
                          <Skeleton className="h-8 w-full" />
                        </div>
                      ) : filtered.length === 0 ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          Nothing matches — the gate keeps uncleared tracks off
                          this list.
                        </p>
                      ) : (
                        filtered.map((t) => (
                          <button
                            key={t.id}
                            role="option"
                            aria-selected={false}
                            onClick={() => {
                              setSelected(t)
                              setPickerOpen(false)
                            }}
                            className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent/60"
                          >
                            <span className="min-w-0 truncate">
                              {t.explicit && (
                                <span className="mr-1.5 rounded bg-red-500/20 px-1 text-[10px] font-bold text-red-400">
                                  E
                                </span>
                              )}
                              <span className="font-medium">{t.title}</span>
                              <span className="text-muted-foreground">
                                {' '}
                                — {t.artist}
                              </span>
                            </span>
                            <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                              {t.rightsId}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={32}
                placeholder="Your on-air name"
                aria-label="Your on-air name"
              />
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={140}
                placeholder="Shout-out (optional)"
                aria-label="Optional shout-out note"
              />
            </div>
            <Button
              onClick={submit}
              disabled={!selected || !name.trim() || submitting}
              className="w-full sm:w-auto"
              aria-label="Send track request"
            >
              <Send className="h-4 w-4" aria-hidden="true" />
              {submitting ? 'Sending…' : 'Send it to the booth'}
            </Button>
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              Requests can never fast-track an uncleared record.
            </p>

            {/* how a shout becomes a spin — fills the column and explains the loop */}
            <div className="mt-auto grid grid-cols-3 gap-2 border-t border-border/40 pt-3 [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:left-[-8px] [&>*+*]:before:top-1/2 [&>*+*]:before:h-px [&>*+*]:before:w-4 [&>*+*]:before:-translate-y-1/2 [&>*+*]:before:bg-border">
              {[
                { n: '1', label: 'Pick a cleared track' },
                { n: '2', label: 'Shout it out' },
                { n: '3', label: 'Wheel reorders in ~1 min' },
              ].map((s) => (
                <div key={s.n} className="text-center">
                  <span className="mx-auto flex h-6 w-6 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-[10px] font-bold text-primary">
                    {s.n}
                  </span>
                  <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">{s.label}</p>
                </div>
              ))}
            </div>
          </motion.div>

          {/* ---- top requests + recent shouts ---- */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: 0.06 }}
            className="h-full rounded-xl border border-border/60 bg-card/60 p-4 sm:p-5"
          >
            <div className="mb-3 flex items-center gap-2 text-sm font-semibold">
              <ListMusic className="h-4 w-4 text-primary" aria-hidden="true" />
              Most wanted
              <span className="text-xs font-normal text-muted-foreground">
                · last 7 days
              </span>
            </div>
            {!requests ? (
              <div className="space-y-2">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-full" />
              </div>
            ) : requests.top.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border/70 p-4 text-sm text-muted-foreground">
                No shouts yet — be the first to move the DJ.
              </p>
            ) : (
              <ul className="mb-4 space-y-1.5">
                {requests.top.map((t, i) => (
                  <li
                    key={t.trackId}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm',
                      i === 0
                        ? 'border-primary/40 bg-primary/10'
                        : 'border-border/50 bg-background/40',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold',
                        i === 0
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{t.title}</span>
                      <span className="text-muted-foreground"> — {t.artist}</span>
                    </span>
                    {t.explicit && (
                      <span className="rounded bg-red-500/20 px-1 text-[10px] font-bold text-red-400">
                        E
                      </span>
                    )}
                    <span
                      className="flex shrink-0 items-center gap-1 font-mono text-xs text-primary"
                      title={`${t.count} request${t.count === 1 ? '' : 's'}`}
                    >
                      <Flame className="h-3.5 w-3.5" aria-hidden="true" />
                      {t.count}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {requests && requests.recent.length > 0 && (
              <>
                <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  <MessageSquareQuote className="h-3.5 w-3.5" aria-hidden="true" />
                  Fresh shouts
                </div>
                <ul className="scrollbar-thin max-h-40 space-y-1.5 overflow-y-auto pr-1">
                  {requests.recent.slice(0, 5).map((r) => (
                    <li key={r.id} className="text-xs text-muted-foreground">
                      <span className="font-medium text-foreground/90">
                        {r.listenerName}
                      </span>{' '}
                      → {r.trackTitle}
                      {r.note && (
                        <span className="italic"> · “{r.note}”</span>
                      )}{' '}
                      <span className="font-mono text-[10px]">
                        {timeAgo(r.createdAt, now)}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </motion.div>
        </div>
      )}
    </section>
  )
}
