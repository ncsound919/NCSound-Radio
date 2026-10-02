'use client'

import { useCallback, useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Keyboard, Radio, ShieldCheck, MapPin } from 'lucide-react'
import { StationHeader } from '@/components/station/header'
import { PlayerBar } from '@/components/station/player-bar'
import { OnAirSection } from '@/components/station/on-air-section'
import { ShortcutsDialog } from '@/components/station/shortcuts-dialog'
import { ScheduleSection } from '@/components/sections/schedule-section'
import { SubmitSection } from '@/components/sections/submit-section'
import { RightsSection } from '@/components/sections/rights-section'
import { SponsorsSection } from '@/components/sections/sponsors-section'
import { OpsSection } from '@/components/sections/ops-section'
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts'
import type { TabId } from '@/lib/station-types'

const TAB_ORDER: TabId[] = ['on-air', 'schedule', 'submit', 'rights', 'sponsors', 'ops']

export function AppShell() {
  const [tab, setTab] = useState<TabId>('on-air')
  const [shortcutsOpen, setShortcutsOpen] = useKeyboardShortcuts(setTab)

  const navigate = useCallback((t: string) => {
    if (TAB_ORDER.includes(t as TabId)) setTab(t as TabId)
  }, [])

  // panel switch resets the viewport like a real page change — otherwise a
  // deep scroll on a long panel drops you mid-footer on the next one
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: 'auto' })
  }, [tab])

  return (
    <div className="min-h-screen flex flex-col bg-studio">
      <StationHeader activeTab={tab} onTabChange={setTab} />

      <main id="main" className="flex-1 w-full max-w-7xl mx-auto px-4 sm:px-6 pt-6 pb-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
          >
            {tab === 'on-air' && <OnAirSection onNavigate={navigate} />}
            {tab === 'schedule' && <ScheduleSection onNavigate={navigate} />}
            {tab === 'submit' && <SubmitSection />}
            {tab === 'rights' && <RightsSection />}
            {tab === 'sponsors' && <SponsorsSection />}
            {tab === 'ops' && <OpsSection />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="mt-auto border-t border-border/60 bg-card/40 backdrop-blur-sm pb-24">
        {/* signal wave divider */}
        <div className="signal-wave" aria-hidden="true" />

        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 grid gap-6 sm:grid-cols-3 text-sm">
          <div>
            <div className="flex items-center gap-2 font-semibold tracking-tight">
              <Radio className="h-4 w-4 text-primary" />
              WAVC 91.3 FM — Carolina Waves
            </div>
            <p className="mt-2 text-muted-foreground leading-relaxed">
              The Carolinas&rsquo; independent hip-hop signal. Streaming 24/7 from the
              Piedmont. Powered by AzuraCast &middot; Icecast 128 kbps.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <ShieldCheck className="h-4 w-4 text-primary" />
              Rights Gate
            </div>
            <p className="mt-2 text-muted-foreground leading-relaxed">
              Every track on this station airs only after its rights record reads
              CLEARED. No cleared record, no broadcast — that is the audit trail.
            </p>
          </div>
          <div>
            <div className="flex items-center gap-2 font-semibold">
              <MapPin className="h-4 w-4 text-primary" />
              Find Us
            </div>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              <li>Directory listing: TuneIn &middot; Radio Browser</li>
              <li>Studio line: (910) 555-0191</li>
              <li>&copy; {new Date().getFullYear()} WAVC 91.3 FM. All bars reserved.</li>
            </ul>
          </div>
        </div>

        {/* keyboard hint row */}
        <div className="max-w-7xl mx-auto px-4 sm:px-6 pb-4">
          <button
            type="button"
            onClick={() => setShortcutsOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            aria-label="Show keyboard shortcuts"
          >
            <Keyboard className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
            <span>
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">Space</kbd>{' '}
              play &middot;{' '}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">1–6</kbd>{' '}
              switch panels &middot;{' '}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">S</kbd>{' '}
              sleep timer &middot;{' '}
              <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">?</kbd>{' '}
              shortcuts
            </span>
          </button>
        </div>
      </footer>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
      <PlayerBar />
    </div>
  )
}
