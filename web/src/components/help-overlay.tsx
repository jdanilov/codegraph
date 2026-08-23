/**
 * Keyboard help — the one screen that says the disk is drivable without a mouse.
 *
 * Round 4 added arrow-key navigation, and a shortcut nobody can discover is a
 * shortcut nobody has. This is deliberately a compact READOUT, not a dialog with
 * anything to do in it: it lists what the keys do and gets out of the way. Esc
 * closes it (the shell owns Escape and puts this at the top of the priority list
 * with the other dialogs), and, like every other surface here, it has no
 * transitions — it is simply there or not.
 */
import { Keyboard } from 'lucide-react';

import { Card } from '@/components/ui/card';

/** One row per binding. Grouped by what the key is FOR, not by key order. */
const SHORTCUTS: Array<{ group: string; rows: Array<[string, string]> }> = [
  {
    group: 'find',
    rows: [
      ['⌘P  /  Ctrl+P', 'search the whole project by name'],
      ['Enter', 're-root the disk onto the selected wedge'],
    ],
  },
  {
    group: 'move',
    rows: [
      ['← →', 'previous / next sibling, in the order they are drawn'],
      ['↑', 'select the wedge that contains this one'],
      ['↓', 'select the first wedge inside this one'],
    ],
  },
  {
    group: 'leave',
    rows: [
      ['Esc', 'close this, then dialogs, then the selection'],
      ['Back / Forward', 'walk the selections and folders you opened'],
    ],
  },
];

export function HelpOverlay({ open, onClose }: { open: boolean; onClose(): void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 p-6 backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="help-overlay"
    >
      {/* Same panel treatment as the settings dialog — one `Card`, so the two
          dialogs cannot drift. It used to hand-roll the classes and named a
          `bg-card` colour this theme does not define, so it rendered with no
          background at all and the disk showed straight through the text. */}
      <Card className="w-[26rem] p-4 shadow-xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted">
          <Keyboard className="h-3 w-3" /> keyboard
        </div>
        <dl className="mt-3 flex flex-col gap-3">
          {SHORTCUTS.map((section) => (
            <div key={section.group} className="flex flex-col gap-1">
              <div className="text-[9px] uppercase tracking-[0.18em] text-muted/70">
                {section.group}
              </div>
              {section.rows.map(([keys, meaning]) => (
                <div key={keys} className="flex items-baseline gap-3 text-[11px]">
                  <dt className="w-32 shrink-0 font-mono text-foreground/90">{keys}</dt>
                  <dd className="min-w-0 flex-1 text-muted">{meaning}</dd>
                </div>
              ))}
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
