/**
 * The frame every floating panel on the right-hand side wears.
 *
 * Phase F split the selection surface in two — a NODE panel and a CODE panel —
 * and dropped the close button that used to sit on the old single card. Closing
 * was the wrong verb: it threw the selection away to get the code out of the
 * way, and there was no way back except re-clicking the arc. Both panels
 * COLLAPSE instead (the selection survives, the panel folds to its title bar),
 * and Esc is what clears the selection outright.
 *
 * The title bar is also where the panel's actions live — the editor jump, the
 * source/changes toggle — because a panel that spends its width on code has
 * none left for a row of buttons under it.
 */
import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface SidePanelProps {
  /** Title-bar label. */
  title: ReactNode;
  /** Muted detail after the title (a line range, a count). */
  meta?: ReactNode;
  /** Leading glyph — the node's kind icon, say. */
  icon?: ReactNode;
  /** Title-bar controls, rendered before the collapse toggle. */
  actions?: ReactNode;
  collapsed: boolean;
  onToggleCollapsed(): void;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
  'data-testid'?: string;
}

export function SidePanel({
  title,
  meta,
  icon,
  actions,
  collapsed,
  onToggleCollapsed,
  className,
  bodyClassName,
  children,
  ...rest
}: SidePanelProps) {
  return (
    <Card
      className={cn('pointer-events-auto flex min-h-0 flex-col overflow-hidden', className)}
      data-collapsed={collapsed}
      data-testid={rest['data-testid']}
    >
      <div className="flex shrink-0 items-center gap-2 px-2.5 py-1.5">
        {icon ? <span className="flex shrink-0 items-center text-muted">{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{title}</span>
        {meta ? <span className="shrink-0 font-mono text-[10px] text-muted">{meta}</span> : null}
        {actions}
        <PanelButton
          onClick={onToggleCollapsed}
          label={collapsed ? 'Expand panel' : 'Collapse panel'}
        >
          {collapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </PanelButton>
      </div>
      {collapsed ? null : (
        <div className={cn('min-h-0 flex-1 overflow-auto border-t border-border/60', bodyClassName)}>
          {children}
        </div>
      )}
    </Card>
  );
}

/**
 * A title-bar icon button. No transition anywhere in the DOM chrome (phase F):
 * hover feedback is instant, and only the canvas animates.
 */
export function PanelButton({
  onClick,
  label,
  active,
  children,
  ...rest
}: {
  onClick(): void;
  label: string;
  active?: boolean;
  children: ReactNode;
  'data-testid'?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      data-testid={rest['data-testid']}
      className={cn(
        'shrink-0 rounded p-1',
        active ? 'bg-accent/20 text-accent' : 'text-muted hover:bg-accent/10 hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}
