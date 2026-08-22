/**
 * The graph canvas — the app's background layer.
 *
 * React's job here is narrow on purpose: mount the WebGL surface, forward user
 * intent to `CanvasController`, and render the floating chrome (legend, edge
 * chips, selection card, tooltip) on top of it. The heavy loop — layout ticks
 * and 1,000+ position writes per frame — never touches React state.
 *
 * PHASE C: `renderDetail` swaps the stub selection card body for the real info
 * panel, `onSelect` lets an outer panel follow the canvas selection, and
 * `onController` hands the shell the imperative handle Cmd+P needs to reveal a
 * node (expand its ancestors, select it, fly the camera to it).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Crosshair, Layers, Pin } from 'lucide-react';

import { EdgeKindChips } from './edge-kind-chips';
import { EdgeTooltip } from './edge-tooltip';
import { Legend } from './legend';
import { SelectionCard } from './selection-card';
import {
  CanvasController,
  type EdgeTooltip as EdgeTooltipData,
  type ViewSummary,
} from '@/graph/canvas-controller';
import type { GraphModel, ModelNode } from '@/graph/model';
import type { ColorMode } from '@/graph/palette';
import { MOUNT_BUDGET } from '@/graph/view';
import { formatNumber } from '@/lib/utils';

const EMPTY_SUMMARY: ViewSummary = {
  mounted: 0,
  primaries: 0,
  satellites: 0,
  visibleEdges: 0,
  hiddenByBudget: false,
  presentColorKeys: [],
  expandedCount: 0,
  pinnedCount: 0,
  edgeKinds: [],
  enabledKinds: [],
};

export interface GraphCanvasProps {
  model: GraphModel | null;
  /** Rendered inside the selection card; phase C's info panel plugs in here. */
  renderDetail?(node: ModelNode): ReactNode;
  onSelect?(node: ModelNode | null): void;
  /** Published on mount and nulled on unmount — the shell's imperative handle. */
  onController?(controller: CanvasController | null): void;
  /**
   * Phase D: colour mode becomes CONTROLLED when supplied, because it is part
   * of the URL state the shell restores. Left out, the canvas owns it exactly
   * as before.
   */
  colorMode?: ColorMode;
  onColorModeChange?(mode: ColorMode): void;
  /** Mirror of the mounted-view summary — the shell re-encodes the URL from it. */
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
  const [tooltip, setTooltip] = useState<EdgeTooltipData | null>(null);
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
      onEdgeTooltip: setTooltip,
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
    // view. The same root is a re-index — keep expansion, pins and camera.
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
  }, [model, colorMode]);

  const toggleKind = useCallback(
    (kind: string) => {
      const controller = controllerRef.current;
      if (!controller) return;
      const next = new Set(controller.enabledEdgeKinds());
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      controller.setEdgeKinds(next);
    },
    []
  );

  const clearSelection = useCallback(() => {
    setSelected(null);
    onSelectRef.current?.(null);
    controllerRef.current?.setSelected(null);
  }, []);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {tooltip ? <EdgeTooltip tooltip={tooltip} /> : null}

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
          <EdgeKindChips
            kinds={summary.edgeKinds}
            enabled={new Set(summary.enabledKinds)}
            onToggle={toggleKind}
          />
          <div className="flex flex-col items-end gap-3">
            {selected ? (
              <SelectionCard node={selected} onClose={clearSelection}>
                {renderDetail?.(selected)}
              </SelectionCard>
            ) : null}
            <MountedReadout summary={summary} onFit={() => controllerRef.current?.fitView()} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The mounted-subset readout. It is deliberately visible: the canvas holds a
 * bounded slice of a graph that can be 15k+ nodes, and a user who can't see
 * that would read a collapsed directory as an empty one.
 */
function MountedReadout({ summary, onFit }: { summary: ViewSummary; onFit(): void }) {
  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-surface/70 px-3 py-1.5 text-[10px] text-muted shadow-sm backdrop-blur-md">
      <span className="flex items-center gap-1.5" title="nodes mounted in the renderer">
        <Layers className="h-3 w-3" />
        {formatNumber(summary.mounted)}/{formatNumber(MOUNT_BUDGET)}
      </span>
      <span title="satellites hugging collapsed parents">{summary.satellites} sat</span>
      <span title="relation edges drawn">{formatNumber(summary.visibleEdges)} edges</span>
      {summary.pinnedCount > 0 ? (
        <span className="flex items-center gap-1 text-accent" title="pinned nodes">
          <Pin className="h-3 w-3" />
          {summary.pinnedCount}
        </span>
      ) : null}
      {summary.hiddenByBudget ? (
        <span className="text-accent" title="some children are hidden by the render budget">
          capped
        </span>
      ) : null}
      <button
        type="button"
        onClick={onFit}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-background/60 hover:text-foreground"
        title="Fit the graph to the viewport"
      >
        <Crosshair className="h-3 w-3" /> fit
      </button>
    </div>
  );
}
