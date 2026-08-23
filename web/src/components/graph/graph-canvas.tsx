/**
 * The graph canvas — the app's background layer.
 *
 * React's job here is narrow on purpose: mount the 2D surface, forward user
 * intent to `CanvasController`, and render the one piece of chrome that belongs
 * to the DISK itself — the arc tooltip. Painting never touches React state.
 *
 * PHASE E: the representation is a DaisyDisk-style **sunburst** — the current
 * root at the centre, one ring per level, angle ∝ LoC — replacing the force
 * layout.
 *
 * PHASE F (panels): every floating PANEL moved out of here and into the shell.
 * The legend and the fit control now live in the left column with the
 * questions, and the selection is rendered by the shell as two right-hand
 * panels (node + code) rather than by a `renderDetail` slot inside the canvas.
 *
 * ROUND 2: the bottom band went too — the breadcrumb and the edge-kind chips.
 * Up-navigation is the centre circle (which now names where you are), ⌘P and
 * the URL; the chips were a filter nobody reached for, sitting across the
 * bottom of every screenshot. `onSelect`, `onController` and `onViewChange` are
 * unchanged — they are how the shell drives it, and the controller still keeps
 * `setEdgeKinds`/`enabledEdgeKinds` for the URL state to restore.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ArcTooltip } from './arc-tooltip';
import {
  CanvasController,
  type ArcTooltip as ArcTooltipData,
  type ViewSummary,
} from '@/graph/canvas-controller';
import type { GraphModel, ModelNode } from '@/graph/model';
import type { ColorMode } from '@/graph/palette';
import type { SortMode } from '@/graph/sunburst';

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
      // Nothing in this component renders the summary any more — it goes
      // straight to the shell (colour keys for the legend, URL state).
      onViewChange: (next) => {
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

  return (
    <div className="absolute inset-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />

      {/* Wedges only: an edge never raises a tooltip (phase F). */}
      {arcTooltip ? <ArcTooltip tooltip={arcTooltip} /> : null}
    </div>
  );
}
