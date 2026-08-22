/**
 * The graph canvas — the app's background layer.
 *
 * React's job here is narrow on purpose: mount the 2D surface, forward user
 * intent to `CanvasController`, and render the floating chrome (breadcrumb,
 * legend, edge chips, selection card, tooltips) on top of it. Painting never
 * touches React state.
 *
 * PHASE E: the representation is a DaisyDisk-style **sunburst** — the current
 * root at the centre, one ring per level, angle ∝ LoC — replacing the force
 * layout. The mount contracts are unchanged: `renderDetail` fills the selection
 * card, `onSelect` publishes the selection, `onController` hands the shell the
 * imperative handle ⌘P and the cards drive.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Crosshair, Layers } from 'lucide-react';

import { ArcTooltip } from './arc-tooltip';
import { EdgeKindChips } from './edge-kind-chips';
import { EdgeTooltip } from './edge-tooltip';
import { Legend } from './legend';
import { SelectionCard } from './selection-card';
import {
  ARC_BUDGET,
  CanvasController,
  type ArcTooltip as ArcTooltipData,
  type EdgeTooltip as EdgeTooltipData,
  type ViewSummary,
} from '@/graph/canvas-controller';
import type { GraphModel, ModelNode } from '@/graph/model';
import type { ColorMode } from '@/graph/palette';
import { cn, formatNumber } from '@/lib/utils';

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
  /** Rendered inside the selection card; phase C's info panel plugs in here. */
  renderDetail?(node: ModelNode): ReactNode;
  onSelect?(node: ModelNode | null): void;
  /** Published on mount and nulled on unmount — the shell's imperative handle. */
  onController?(controller: CanvasController | null): void;
  /**
   * Colour mode is CONTROLLED when supplied, because it is part of the URL
   * state the shell restores. Left out, the canvas owns it.
   */
  colorMode?: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  /** Mirror of the view summary — the shell re-encodes the URL from it. */
  onViewChange?(summary: ViewSummary): void;
}

export function GraphCanvas({
  model,
  renderDetail,
  onSelect,
  onController,
  colorMode: controlledColorMode,
  onColorModeChange,
  onViewChange,
}: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<CanvasController | null>(null);
  const [summary, setSummary] = useState<ViewSummary>(EMPTY_SUMMARY);
  const [selected, setSelected] = useState<ModelNode | null>(null);
  const [edgeTooltip, setEdgeTooltip] = useState<EdgeTooltipData | null>(null);
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
        setSelected(node);
        onSelectRef.current?.(node);
      },
      onViewChange: (next) => {
        setSummary(next);
        onViewChangeRef.current?.(next);
      },
      onEdgeTooltip: setEdgeTooltip,
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

  const clearSelection = useCallback(() => {
    setSelected(null);
    onSelectRef.current?.(null);
    controllerRef.current?.setSelected(null);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {edgeTooltip ? <EdgeTooltip tooltip={edgeTooltip} /> : null}
      {!edgeTooltip && arcTooltip ? <ArcTooltip tooltip={arcTooltip} /> : null}

      {/* Chrome floats over the canvas; only the widgets take pointer events. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-4">
        <div className="flex items-start justify-end gap-3">
          <Legend
            mode={colorMode}
            onModeChange={setColorMode}
            layers={model?.layers ?? []}
            present={summary.presentColorKeys}
          />
        </div>

        <div className="flex items-end justify-between gap-3">
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
          <div className="flex flex-col items-end gap-3">
            {selected ? (
              <SelectionCard node={selected} onClose={clearSelection}>
                {renderDetail?.(selected)}
              </SelectionCard>
            ) : null}
            <DiskReadout summary={summary} onFit={() => controllerRef.current?.fitView()} />
          </div>
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
    <nav className="pointer-events-auto flex max-w-[36rem] flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface/70 px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur-md">
      {trail.map((entry, index) => (
        <span key={entry.id} className="flex items-center gap-0.5">
          {index > 0 ? <ChevronRight className="h-3 w-3 shrink-0 text-muted/60" /> : null}
          <button
            type="button"
            onClick={() => onPick(entry.id)}
            disabled={index === trail.length - 1}
            className={cn(
              'max-w-[12rem] truncate rounded px-1 py-0.5 transition-colors',
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

/**
 * The rendered-subset readout. It is deliberately visible: the disk holds a
 * bounded slice of a graph that can be 15k+ nodes, and a user who can't see
 * that would read an aggregated arc as the whole truth.
 */
function DiskReadout({ summary, onFit }: { summary: ViewSummary; onFit(): void }) {
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface/70 px-3 py-1.5 text-[10px] text-muted shadow-sm backdrop-blur-md">
      <span className="flex items-center gap-1.5" title="arcs drawn on the disk">
        <Layers className="h-3 w-3" />
        {formatNumber(summary.arcs)}/{formatNumber(ARC_BUDGET)}
      </span>
      <span title="rings drawn outward from the current root">{summary.rings} rings</span>
      <span title="bundled relations currently drawn">
        {formatNumber(summary.visibleEdges)} edges
      </span>
      {summary.zoom !== 1 ? <span title="zoom">{summary.zoom.toFixed(1)}×</span> : null}
      {summary.truncated ? (
        <span className="text-accent" title="deeper levels are folded into “+N smaller” arcs">
          folded
        </span>
      ) : null}
      <button
        type="button"
        onClick={onFit}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-background/60 hover:text-foreground"
        title="Reset zoom and centre the disk"
      >
        <Crosshair className="h-3 w-3" /> fit
      </button>
    </div>
  );
}
