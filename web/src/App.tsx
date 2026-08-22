/**
 * App shell.
 *
 * The canvas IS the app: it fills the viewport as the background layer and
 * every other surface floats on top of it (contract: "minimal + light
 * futuristic; graph is the background; code panels / views float on top").
 *
 * Phase C hangs three things off the canvas:
 *
 *  - `renderDetail` fills the floating selection card with the real
 *    `/api/node/:id` info panel (relations, source, editor jump);
 *  - `onController` hands this shell the imperative handle that Cmd+P needs to
 *    *reveal* a node — expand its ancestors, select it, fly the camera to it;
 *  - `onSelect` mirrors the canvas selection here, so a later phase can drive
 *    a card or a view from it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, Settings as SettingsIcon } from 'lucide-react';

import { CommandPalette } from '@/components/command-palette';
import { SettingsDialog } from '@/components/settings-dialog';
import { GraphCanvas } from '@/components/graph/graph-canvas';
import { NodePanel } from '@/components/graph/node-panel';
import { StatusPanel } from '@/components/graph/status-panel';
import type { CanvasController } from '@/graph/canvas-controller';
import { useGraphData } from '@/graph/use-graph-data';

export default function App() {
  const { status, model, error, indexing, indexLog, runIndex } = useGraphData();
  const controllerRef = useRef<CanvasController | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Cmd/Ctrl+P opens the palette. Captured on the window because the canvas is
  // a WebGL surface with no focusable children to hang a handler on.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Select a node and bring it on screen — used by the palette and the panel. */
  const navigate = useCallback((id: string) => {
    controllerRef.current?.reveal(id);
  }, []);

  return (
    <div className="relative h-full w-full">
      <GraphCanvas
        model={model}
        onController={(controller) => {
          controllerRef.current = controller;
        }}
        renderDetail={(node) => (
          <NodePanel
            node={node}
            model={model}
            root={status?.root ?? null}
            onNavigate={navigate}
          />
        )}
      />

      <div className="pointer-events-none absolute inset-0 p-4">
        <div className="flex w-[22rem] flex-col gap-3">
          <StatusPanel
            status={status}
            error={error}
            indexing={indexing}
            indexLog={indexLog}
            onIndex={() => void runIndex()}
          />
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              data-testid="open-palette"
              className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface/70 px-3 py-1.5 text-[11px] text-muted shadow-sm backdrop-blur-md transition-colors hover:border-accent/50 hover:text-foreground"
            >
              <Search className="h-3 w-3" />
              <span className="flex-1 text-left">Search the graph…</span>
              <kbd className="rounded border border-border px-1 py-0.5 text-[9px]">⌘P</kbd>
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              data-testid="open-settings"
              className="rounded-lg border border-border bg-surface/70 p-2 text-muted shadow-sm backdrop-blur-md transition-colors hover:border-accent/50 hover:text-foreground"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={navigate}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
