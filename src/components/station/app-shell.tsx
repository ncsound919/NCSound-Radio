'use client'

import { useCallback, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Radio, ShieldCheck, MapPin } from 'lucide-react'
import { StationHeader } from '@/components/station/header'
import { PlayerBar } from '@/components/station/player-bar'
import { OnAirSection } from '@/components/station/on-air-section'
import { ScheduleSection } from '@/components/sections/schedule-section'
import { SubmitSection } from '@/components/sections/submit-section'
import { RightsSection } from '@/components/sections/rights-section'
import { SponsorsSection } from '@/components/sections/sponsors-section'
import { OpsSection } from '@/components/sections/ops-section'
import type { TabId } from '@/lib/station-types'

const TAB_ORDER: TabId[] = ['on-air', 'schedule', 'submit', 'rights', 'sponsors', 'ops']

export function AppShell() {
  const [tab, setTab] = useState<TabId>('on-air')

  const navigate = useCallback((t: string) => {
    if (TAB_ORDER.includes(t as TabId)) setTab(t as TabId)
  }, [])

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
            {tab === 'schedule' && <ScheduleSection />}
            {tab === 'submit' && <SubmitSection />}
            {tab === 'rights' && <RightsSection />}
            {tab === 'sponsors' && <SponsorsSection />}
            {tab === 'ops' && <OpsSection />}
          </motion.div>
        </AnimatePresence>
      </main>

      <footer className="mt-auto border-t border-border/60 bg-card/40 backdrop-blur-sm pb-24">
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
      </footer>

      <PlayerBar />
    </div>
  )
}
