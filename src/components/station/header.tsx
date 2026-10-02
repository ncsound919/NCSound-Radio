'use client'

import { useEffect, useState } from 'react'
import Image from 'next/image'
import {
  CalendarClock,
  Megaphone,
  Menu,
  Radio,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  Users,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { useNowPlaying } from '@/hooks/use-nowplaying'
import type { TabId } from '@/lib/station-types'
import { cn } from '@/lib/utils'

const TABS: Array<{ id: TabId; label: string; icon: LucideIcon }> = [
  { id: 'on-air', label: 'On Air', icon: Radio },
  { id: 'schedule', label: 'Schedule', icon: CalendarClock },
  { id: 'submit', label: 'Submit', icon: Upload },
  { id: 'rights', label: 'Rights', icon: ShieldCheck },
  { id: 'sponsors', label: 'Sponsors', icon: Megaphone },
  { id: 'ops', label: 'Ops', icon: SlidersHorizontal },
]

/** Eastern Time clock, refreshed every 30 s (client-only to avoid hydration drift). */
function useEtClock(): string | null {
  const [time, setTime] = useState<string | null>(null)
  useEffect(() => {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    })
    const update = () => setTime(fmt.format(new Date()))
    update()
    const id = setInterval(update, 30_000)
    return () => clearInterval(id)
  }, [])
  return time
}

function OnAirBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[10px] font-bold uppercase tracking-widest text-red-400',
        className
      )}
    >
      <span className="animate-onair h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
      On Air
    </span>
  )
}

function EtClock({ className }: { className?: string }) {
  const time = useEtClock()
  return (
    <span className={cn('font-mono text-xs text-muted-foreground', className)}>
      {time ? `${time} ET` : '— ET'}
    </span>
  )
}

function ListenerChip({ count }: { count: number | null }) {
  return (
    <span
      title="Current listeners"
      className="hidden items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-xs font-medium text-foreground/90 md:inline-flex"
    >
      <Users className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
      {count === null ? '—' : count.toLocaleString()}
    </span>
  )
}

export function StationHeader({
  activeTab,
  onTabChange,
}: {
  activeTab: TabId
  onTabChange: (t: TabId) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const { data } = useNowPlaying()
  const listeners = data ? data.listeners.current : null

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/80 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
        {/* Brand */}
        <button
          type="button"
          onClick={() => onTabChange('on-air')}
          aria-label="WAVC 91.3 — go to On Air"
          className="flex min-w-0 items-center gap-2.5 rounded-md text-left transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <Image
            src="/station-logo.png"
            alt="WAVC 91.3 station logo"
            width={36}
            height={36}
            priority
            className="h-9 w-9 rounded-md"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold tracking-tight sm:text-base">
              WAVC 91.3
            </span>
            <span className="block truncate text-xs text-muted-foreground">Carolina Waves</span>
          </span>
        </button>

        {/* Primary nav (desktop) */}
        <nav className="ml-6 hidden items-center gap-1 lg:flex" aria-label="Primary">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => onTabChange(id)}
              aria-current={activeTab === id ? 'page' : undefined}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors',
                activeTab === id
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-2.5">
          <OnAirBadge />
          <ListenerChip count={listeners} />
          <EtClock className="hidden md:inline" />

          {/* Mobile menu */}
          <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
            <SheetTrigger asChild>
              {/* suppressHydrationWarning: Radix generates the aria-controls id
                  separately during SSR and client hydration (dev-only attribute
                  mismatch); the value self-corrects when the sheet opens. */}
              <Button
                variant="outline"
                size="icon"
                className="lg:hidden"
                aria-label="Open navigation menu"
                suppressHydrationWarning
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72">
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <Radio className="h-4 w-4 text-primary" aria-hidden="true" />
                  WAVC 91.3
                </SheetTitle>
                <SheetDescription>Station navigation</SheetDescription>
              </SheetHeader>
              <nav className="flex flex-col gap-1 px-2" aria-label="Mobile navigation">
                {TABS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => {
                      onTabChange(id)
                      setMenuOpen(false)
                    }}
                    aria-current={activeTab === id ? 'page' : undefined}
                    className={cn(
                      'flex h-11 w-full items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                      activeTab === id
                        ? 'bg-primary/15 text-primary'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    {label}
                  </button>
                ))}
              </nav>
              <div className="mt-auto space-y-3">
                {/* keyboard shortcut hint (the shortcuts also work on desktop) */}
                <div className="mx-3 rounded-md border border-border/60 bg-background/40 px-3 py-2">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                    Quick keys
                  </p>
                  <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
                    <li className="flex items-center justify-between">
                      <span>Play / pause</span>
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                        Space
                      </kbd>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>Switch panels</span>
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                        1–6
                      </kbd>
                    </li>
                    <li className="flex items-center justify-between">
                      <span>All shortcuts</span>
                      <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/80">
                        ?
                      </kbd>
                    </li>
                  </ul>
                </div>
                <div className="flex items-center justify-between border-t border-border/60 px-3 pb-2">
                  <OnAirBadge />
                  <EtClock />
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  )
}
