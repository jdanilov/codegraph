/**
 * The graph canvas — the app's background layer.
 *
 * React's job here is narrow on purpose: mount the 2D surface, forward user
 * intent to `CanvasController`, and render the chrome that belongs to the DISK
 * itself (breadcrumb, edge-kind chips, arc tooltip) on top of it. Painting never
 * touches React state.
 *
 * PHASE E: the representation is a DaisyDisk-style **sunburst** — the current
 * root at the centre, one ring per level, angle ∝ LoC — replacing the force
 * layout.
 *
 * PHASE F (panels): every floating PANEL moved out of here and into the shell.
 * The legend and the fit control now live in the left column with the
 * questions, and the selection is rendered by the shell as two right-hand
 * panels (node + code) rather than by a `renderDetail` slot inside the canvas.
 * The canvas keeps exactly the controls that mean nothing without the disk
 * under them. `onSelect`, `onController` and `onViewChange` are unchanged —
 * they are how the shell drives it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

import { ArcTooltip } from './arc-tooltip';
import { EdgeKindChips } from './edge-kind-chips';
import {
  CanvasController,
  type ArcTooltip as ArcTooltipData,
  type ViewSummary,
} from '@/graph/canvas-controller';
import type { GraphModel, ModelNode } from '@/graph/model';
import type { ColorMode } from '@/graph/palette';
import type { SortMode } from '@/graph/sunburst';
import { cn } from '@/lib/utils';

const EMPTY_SUMMARY: ViewSummary = {
  arcs: 0,
  rings: 0,
  truncated: false,
  visibleEdges: 0,
  presentColorKeys: [],
  edgeKinds: [],
  enabledKinds: [],
  breadcrumb: [],
  zoom: 1,
};

export interface GraphCanvasProps {
  model: GraphModel | null;
  onSelect?(node: ModelNode | null): void;
  /** Published on mount and nulled on unmount — the shell's imperative handle. */
  onController?(controller: CanvasController | null): void;
  /**
   * Colour mode is CONTROLLED when supplied, because it is part of the URL
   * state the shell restores. Left out, the canvas owns it.
   */
  colorMode?: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  /**
   * Sibling order on the disk (phase F). Controlled by the shell, which reads
   * it from the user's settings; the canvas falls back to the layout default.
   */
  sortMode?: SortMode;
  /** Mirror of the view summary — the shell re-encodes the URL from it. */
  onViewChange?(summary: ViewSummary): void;
}

export function GraphCanvas({
  model,
  onSelect,
  onController,
  colorMode: controlledColorMode,
  onColorModeChange,
  sortMode,
  onViewChange,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [summary, setSummary] = useState<ViewSummary>(EMPTY_SUMMARY);
  const [arcTooltip, setArcTooltip] = useState<ArcTooltipData | null>(null);
  const [ownColorMode, setOwnColorMode] = useState<ColorMode>('kind');
  const lastRoot = useRef<string | null>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;
  const onColorModeChangeRef = useRef(onColorModeChange);
  onColorModeChangeRef.current = onColorModeChange;
  const onViewChangeRef = useRef(onViewChange);
  onViewChangeRef.current = onViewChange;

  // Controlled when the shell supplies a mode (URL state), self-owned otherwise.
  const colorMode = controlledColorMode ?? ownColorMode;
  const setColorMode = useCallback((mode: ColorMode) => {
    setOwnColorMode(mode);
    onColorModeChangeRef.current?.(mode);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const controller = new CanvasController(container, {
      onSelect: (node) => {
        onSelectRef.current?.(node);
      },
      onViewChange: (next) => {
        setSummary(next);
        onViewChangeRef.current?.(next);
      },
      onArcTooltip: setArcTooltip,
    });
    controllerRef.current = controller;
    onControllerRef.current?.(controller);
    return () => {
      controllerRef.current = null;
      onControllerRef.current?.(null);
      controller.destroy();
    };
  }, []);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !model) return;
    // A different project root means a different graph entirely: reset the
    // view. The same root is a re-index — keep the current root and selection.
    const sameProject = lastRoot.current === model.root;
    lastRoot.current = model.root;
    controller.setModel(model, sameProject);
  }, [model]);

  useEffect(() => {
    controllerRef.current?.setColorMode(colorMode);
  }, [colorMode]);

  useEffect(() => {
    if (sortMode) controllerRef.current?.setSortMode(sortMode);
  }, [sortMode, model]);

  // A project without a layer vocabulary has no layer mode to switch to.
  useEffect(() => {
    if (model && model.layers.length === 0 && colorMode === 'layer') setColorMode('kind');
  }, [model, colorMode, setColorMode]);

  const toggleKind = useCallback((kind: string) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const next = new Set(controller.enabledEdgeKinds());
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    controller.setEdgeKinds(next);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Wedges only: an edge never raises a tooltip (phase F). */}
      {arcTooltip ? <ArcTooltip tooltip={arcTooltip} /> : null}

      {/* Chrome floats over the canvas; only the widgets take pointer events. */}
      {/* Bottom band, clear of the left column's panels and the right column's
          selection panels — the disk's own controls, nothing else. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4 pl-[24rem] pr-[31rem]">
        <div className="flex flex-col gap-3">
          <Breadcrumb
            trail={summary.breadcrumb}
            onPick={(id) => controllerRef.current?.setRoot(id)}
          />
          <EdgeKindChips
            kinds={summary.edgeKinds}
            enabled={new Set(summary.enabledKinds)}
            onToggle={toggleKind}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Project root → … → current root.
 *
 * The disk shows exactly one subtree at a time, so the trail is the only thing
 * telling the user where they are; clicking a step re-roots straight to it.
 */
function Breadcrumb({
  trail,
  onPick,
}: {
  trail: Array<{ id: string; name: string }>;
  onPick(id: string): void;
}) {
  if (trail.length === 0) return null;
  return (
    <nav className="pointer-events-auto flex max-w-[36rem] flex-wrap items-center gap-0.5 self-start rounded-lg border border-border bg-surface/70 px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur-md">
      {trail.map((entry, index) => (
        <span key={entry.id} className="flex items-center gap-0.5">
          {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0 text-muted/60" /> : null}
          <button
            type="button"
            onClick={() => onPick(entry.id)}
            disabled={index === trail.length - 1}
            className={cn(
              'max-w-[12rem] truncate rounded px-1 py-0.5',
              index === trail.length - 1
                ? 'font-medium text-foreground'
                : 'text-muted hover:bg-background/60 hover:text-foreground'
            )}
            title={entry.name}
          >
            {entry.name}
          </button>
        </span>
      ))}
    </nav>
  );
}
