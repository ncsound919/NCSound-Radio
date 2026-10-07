'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import {
  Upload,
  CheckCircle2,
  ShieldCheck,
  GitBranch,
  ChevronRight,
  FileAudio,
  X,
  AlertCircle,
  BookOpen,
} from 'lucide-react'
import { toast } from 'sonner'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { SubmissionLookupCard } from '@/components/station/submission-lookup-card'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SubmissionDTO } from '@/lib/station-types'

const GENRES = ['Hip-Hop', 'Trap', 'Boom Bap', 'Lo-fi', 'Conscious', 'R&B', 'Other'] as const

const STATES = [
  { value: 'NC', label: 'North Carolina' },
  { value: 'SC', label: 'South Carolina' },
  { value: 'GA', label: 'Georgia' },
  { value: 'VA', label: 'Virginia' },
  { value: 'Other', label: 'Other' },
] as const

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

type FormState = {
  artistName: string
  email: string
  trackTitle: string
  genre: string
  explicit: boolean
  city: string
  state: string
  socials: string
  notes: string
}

const EMPTY_FORM: FormState = {
  artistName: '',
  email: '',
  trackTitle: '',
  genre: '',
  explicit: false,
  city: '',
  state: '',
  socials: '',
  notes: '',
}

function fmtSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1000))} KB`
}

function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.artistName.trim()) errors.artistName = 'Artist name is required.'
  if (!form.email.trim()) errors.email = 'Email is required.'
  else if (!EMAIL_RE.test(form.email.trim())) errors.email = 'Enter a valid email address.'
  if (!form.trackTitle.trim()) errors.trackTitle = 'Track title is required.'
  if (!form.genre) errors.genre = 'Pick a genre.'
  return errors
}

export function SubmitSection() {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [agreed, setAgreed] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [file, setFile] = useState<{ name: string; size: number } | null>(null)
  const [posting, setPosting] = useState(false)
  const [success, setSuccess] = useState<SubmissionDTO | null>(null)

  // Prefill state select placeholder once component is interactive
  useEffect(() => {
    setErrors({})
  }, [])

  const setField = useCallback(
    (key: keyof FormState, value: string | boolean) => {
      setForm((prev) => ({ ...prev, [key]: value }))
      setErrors((prev) => {
        if (!prev[key]) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    },
    []
  )

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const errs = validate(form)
    if (!agreed) errs.agreement = 'You must accept the Submission & Licensing Agreement.'
    setErrors(errs)
    if (Object.keys(errs).length > 0) {
      if (errs.agreement) toast.error(errs.agreement)
      return
    }

    setPosting(true)
    try {
      const res = await fetch('/api/submissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artistName: form.artistName.trim(),
          email: form.email.trim(),
          trackTitle: form.trackTitle.trim(),
          genre: form.genre,
          explicit: form.explicit,
          city: form.city.trim() || null,
          state: form.state || null,
          socials: form.socials.trim() || null,
          notes: form.notes.trim() || null,
          agreementAccepted: true,
          fileName: file?.name ?? null,
          fileSize: file?.size ?? null,
        }),
      })
      if (!res.ok) {
        let message = `Submission failed (${res.status})`
        try {
          const body = (await res.json()) as { error?: string }
          if (body?.error) message = body.error
        } catch {
          /* non-JSON error body */
        }
        toast.error(message)
        return
      }
      const json = (await res.json()) as { submission: SubmissionDTO }
      setSuccess(json.submission)
      toast.success(`Submission received — you are #${json.submission.id.slice(-6).toUpperCase()}`)
    } catch {
      toast.error('Network error — could not reach the studio. Try again.')
    } finally {
      setPosting(false)
    }
  }

  function resetForm() {
    setForm(EMPTY_FORM)
    setErrors({})
    setAgreed(false)
    setFile(null)
    setSuccess(null)
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      aria-labelledby="submit-heading"
      className="space-y-6"
    >
      {/* ---- Section header ---- */}
      <div className="flex items-start gap-3">
        <div className="rounded-lg bg-primary/10 p-2 text-primary">
          <Upload className="h-5 w-5" aria-hidden />
        </div>
        <div>
          <h2 id="submit-heading" className="text-xl font-bold tracking-tight">
            Submit Your Track
          </h2>
          <p className="text-sm text-muted-foreground">
            Every submission is reviewed by a person before it can air.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* ---- Left column: form / success panel ---- */}
        <div className="lg:col-span-2">
          {success ? (
            <Card className="border-emerald-500/30 bg-emerald-500/5">
              <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
                <CheckCircle2 className="h-14 w-14 text-emerald-400" aria-hidden />
                <div>
                  <h3 className="text-lg font-bold">Track received</h3>
                  <p className="mt-1 text-sm text-muted-foreground">
                    &ldquo;{success.trackTitle}&rdquo; by {success.artistName} is in the review
                    queue.
                  </p>
                </div>
                {/* Pipeline visual */}
                <div className="flex flex-wrap items-center justify-center gap-1.5">
                  {['Submitted', 'Human review', 'Approved', 'AutoDJ rotation'].map(
                    (step, i) => (
                      <div key={step} className="flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/80 px-2.5 py-1.5 text-xs">
                          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-primary-foreground">
                            {i + 1}
                          </span>
                          {step}
                        </span>
                        {i < 3 && (
                          <ChevronRight className="h-4 w-4 text-muted-foreground" aria-hidden />
                        )}
                      </div>
                    )
                  )}
                </div>
                <p className="text-xs text-muted-foreground">Typical review time: 3–5 days</p>
                <Button variant="ghost" className="h-9" onClick={resetForm}>
                  <Upload className="mr-2 h-4 w-4" aria-hidden /> Submit another
                </Button>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="pb-4">
                <CardTitle className="text-base">Track details</CardTitle>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
                  {/* artistName */}
                  <div className="space-y-1.5">
                    <Label htmlFor="artistName">
                      Artist name <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      id="artistName"
                      value={form.artistName}
                      onChange={(e) => setField('artistName', e.target.value)}
                      placeholder="e.g. 910 Rex"
                      className="h-10"
                      aria-invalid={!!errors.artistName}
                    />
                    {errors.artistName && (
                      <p className="text-xs text-red-400">{errors.artistName}</p>
                    )}
                  </div>
                  {/* email */}
                  <div className="space-y-1.5">
                    <Label htmlFor="email">
                      Email <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      id="email"
                      type="email"
                      value={form.email}
                      onChange={(e) => setField('email', e.target.value)}
                      placeholder="you@label.com"
                      className="h-10"
                      aria-invalid={!!errors.email}
                    />
                    {errors.email && <p className="text-xs text-red-400">{errors.email}</p>}
                  </div>
                  {/* trackTitle */}
                  <div className="space-y-1.5">
                    <Label htmlFor="trackTitle">
                      Track title <span className="text-red-400">*</span>
                    </Label>
                    <Input
                      id="trackTitle"
                      value={form.trackTitle}
                      onChange={(e) => setField('trackTitle', e.target.value)}
                      placeholder="e.g. Cape Fear Anthem"
                      className="h-10"
                      aria-invalid={!!errors.trackTitle}
                    />
                    {errors.trackTitle && (
                      <p className="text-xs text-red-400">{errors.trackTitle}</p>
                    )}
                  </div>
                  {/* genre */}
                  <div className="space-y-1.5">
                    <Label htmlFor="genre">
                      Genre <span className="text-red-400">*</span>
                    </Label>
                    <Select
                      value={form.genre || undefined}
                      onValueChange={(v) => setField('genre', v)}
                    >
                      <SelectTrigger
                        id="genre"
                        className="h-10 w-full"
                        aria-invalid={!!errors.genre}
                      >
                        <SelectValue placeholder="Pick a genre" />
                      </SelectTrigger>
                      <SelectContent>
                        {GENRES.map((g) => (
                          <SelectItem key={g} value={g}>
                            {g}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {errors.genre && <p className="text-xs text-red-400">{errors.genre}</p>}
                  </div>
                  {/* explicit switch */}
                  <div className="sm:col-span-2 rounded-lg border border-border bg-card/40 p-3">
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="explicit" className="text-sm font-medium">
                        Contains explicit lyrics
                      </Label>
                      <Switch
                        id="explicit"
                        checked={form.explicit}
                        onCheckedChange={(v) => setField('explicit', v)}
                      />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      Explicit tracks are excluded from the Clean Daypart 6a–7p ET
                    </p>
                  </div>
                  {/* city */}
                  <div className="space-y-1.5">
                    <Label htmlFor="city">City</Label>
                    <Input
                      id="city"
                      value={form.city}
                      onChange={(e) => setField('city', e.target.value)}
                      placeholder="e.g. Wilmington"
                      className="h-10"
                    />
                  </div>
                  {/* state */}
                  <div className="space-y-1.5">
                    <Label htmlFor="state">State</Label>
                    <Select
                      value={form.state || undefined}
                      onValueChange={(v) => setField('state', v)}
                    >
                      <SelectTrigger id="state" className="h-10 w-full">
                        <SelectValue placeholder="Select state" />
                      </SelectTrigger>
                      <SelectContent>
                        {STATES.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  {/* socials */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="socials">Socials</Label>
                    <Input
                      id="socials"
                      value={form.socials}
                      onChange={(e) => setField('socials', e.target.value)}
                      placeholder="@handle"
                      className="h-10"
                    />
                  </div>
                  {/* notes */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="notes">Notes for the music director</Label>
                    <Textarea
                      id="notes"
                      value={form.notes}
                      onChange={(e) => setField('notes', e.target.value)}
                      placeholder="Who produced it? Any samples?"
                      rows={3}
                    />
                  </div>
                  {/* audio file (metadata only — bytes never leave the browser) */}
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="audioFile">Audio file (metadata only — nothing uploads)</Label>
                    <Input
                      id="audioFile"
                      type="file"
                      accept="audio/*"
                      className="h-10 cursor-pointer"
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        setFile(f ? { name: f.name, size: f.size } : null)
                      }}
                    />
                    {file && (
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className="h-7 border-border bg-card/60 font-mono text-xs"
                        >
                          <FileAudio className="mr-1.5 h-3.5 w-3.5 text-primary" aria-hidden />
                          {file.name} · {fmtSize(file.size)}
                        </Badge>
                        <button
                          type="button"
                          onClick={() => setFile(null)}
                          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          aria-label="Remove selected file"
                        >
                          <X className="h-3 w-3" aria-hidden /> Remove
                        </button>
                      </div>
                    )}
                  </div>
                  {/* agreement */}
                  <div className="space-y-1.5 sm:col-span-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        id="agreement"
                        checked={agreed}
                        onCheckedChange={(v) => setAgreed(v === true)}
                        className="mt-0.5"
                      />
                      <div className="space-y-1">
                        <Label
                          htmlFor="agreement"
                          className="text-sm font-medium leading-snug"
                        >
                          I own or control this recording and agree to the Submission &amp;
                          Licensing Agreement
                        </Label>
                        <div>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-8 px-2 text-xs text-amber-400"
                            onClick={() => setDialogOpen(true)}
                          >
                            <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Read the
                            agreement
                          </Button>
                        </div>
                      </div>
                    </div>
                    {errors.agreement && (
                      <p className="text-xs text-red-400">{errors.agreement}</p>
                    )}
                  </div>
                  {/* submit */}
                  <div className="sm:col-span-2">
                    <Button
                      type="submit"
                      size="lg"
                      className="h-11 w-full font-semibold sm:w-auto"
                      disabled={posting}
                    >
                      <Upload className="mr-2 h-4 w-4" aria-hidden />
                      {posting ? 'Sending to the studio…' : 'Submit for review'}
                    </Button>
                  </div>
                </form>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ---- Right column: pipeline + why we gate ---- */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                  <GitBranch className="h-4 w-4" aria-hidden />
                </div>
                Pipeline
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="leading-relaxed">
                <span className="font-mono text-foreground/90">Submission</span> →{' '}
                <span className="font-mono text-amber-400">IN_REVIEW</span> →{' '}
                <span className="font-mono text-emerald-400">APPROVED</span> → added to AutoDJ.
              </p>
              <p className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-2.5 text-xs text-red-400">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                Blocked tracks never reach the broadcast chain
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <div className="rounded-md bg-primary/10 p-1.5 text-primary">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                </div>
                Why we gate
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-2.5 text-sm text-muted-foreground">
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  Legal protection — documented ownership before a single spin.
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  Every airplay maps back to your signed agreement.
                </li>
                <li className="flex items-start gap-2">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                  Sponsor trust — underwriters know the chain is clean.
                </li>
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ---- Artist-facing status lookup (public half of the pipeline) ---- */}
      <SubmissionLookupCard />

      {/* ---- Agreement dialog ---- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto scrollbar-thin sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Submission &amp; Licensing Agreement — v1.1</DialogTitle>
            <DialogDescription>
              Read before signing. This governs every track submitted to NCSound Radio.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 text-sm leading-relaxed text-muted-foreground">
            <section>
              <h4 className="font-semibold text-foreground">1. Ownership &amp; warranty</h4>
              <p>
                You certify that you own or control the master recording and the underlying
                composition of the submitted track, and that you have the authority to grant the
                license below.
              </p>
            </section>
            <section>
              <h4 className="font-semibold text-foreground">2. Samples</h4>
              <p>
                Clear any samples <strong className="text-foreground">before</strong>{' '}
                you submit. Tracks with uncleared samples are declined.
              </p>
            </section>
            <section>
              <h4 className="font-semibold text-foreground">3. Explicit flag accuracy</h4>
              <p>
                The explicit/non-explicit flag you provide must be accurate. Mislabeling can pull a
                track from rotation and block future submissions.
              </p>
            </section>
            <section>
              <h4 className="font-semibold text-foreground">4. License granted</h4>
              <p>
                You grant NCSound Radio a non-exclusive, royalty-free license to broadcast the track on
                NCSound Radio and its directories. You keep full ownership of your work.
              </p>
            </section>
            <section>
              <h4 className="font-semibold text-foreground">5. Revocation</h4>
              <p>
                Email <span className="font-mono text-foreground">studio@ncsound.fm</span> to pull a
                track within 7 days of notice; we will remove it from rotation and the library.
              </p>
            </section>
            <section>
              <h4 className="font-semibold text-foreground">6. Attribution</h4>
              <p>
                Airplay credit is provided on-air, and every spin is listed in the public song
                history API.
              </p>
            </section>
          </div>
          <DialogFooter>
            <Button
              className="h-9 w-full sm:w-auto"
              onClick={() => {
                setAgreed(true)
                setErrors((prev) => {
                  const next = { ...prev }
                  delete next.agreement
                  return next
                })
                setDialogOpen(false)
                toast.success('Agreement v1.1 accepted')
              }}
            >
              I Agree — v1.1
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </motion.section>
  )
}
