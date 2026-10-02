'use client'

import { Keyboard } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TAB_IDS } from '@/lib/station-types'

const TAB_LABELS: Record<string, string> = {
  'on-air': 'On Air',
  schedule: 'Schedule',
  submit: 'Submit',
  rights: 'Rights',
  sponsors: 'Sponsors',
  ops: 'Ops',
}

const ROWS: Array<{ keys: string[]; action: string }> = [
  { keys: ['Space'], action: 'Play / pause the stream' },
  { keys: ['?'], action: 'Open this shortcut card' },
  { keys: ['Esc'], action: 'Close dialogs' },
]

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Keyboard className="h-4 w-4 text-primary" aria-hidden="true" />
            Station console shortcuts
          </DialogTitle>
          <DialogDescription>
            Drive WAVC like a board op — no mouse required.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {ROWS.map((r) => (
            <li key={r.action} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{r.action}</span>
              <span className="flex gap-1">
                {r.keys.map((k) => (
                  <kbd
                    key={k}
                    className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
          {TAB_IDS.map((id, i) => (
            <li
              key={id}
              className="flex items-center justify-between gap-3 border-t border-border/40 pt-2"
            >
              <span className="text-muted-foreground">
                Jump to {TAB_LABELS[id]}
              </span>
              <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] font-semibold text-foreground">
                {i + 1}
              </kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
