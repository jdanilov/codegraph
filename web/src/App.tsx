/**
 * App shell.
 *
 * The canvas IS the app: it fills the viewport as the background layer and
 * every other surface floats on top of it (contract: "minimal + light
 * futuristic; graph is the background; code panels / views float on top").
 *
 * PHASE C hangs off two `<GraphCanvas>` props documented in that component:
 * `onSelect` publishes the canvas selection to this shell (for Cmd+P search
 * and the source view), and `renderDetail` replaces the stub body of the
 * floating selection card with the real `/api/node/:id` info panel.
 */
import { GraphCanvas } from '@/components/graph/graph-canvas';
import { StatusPanel } from '@/components/graph/status-panel';
import { useGraphData } from '@/graph/use-graph-data';

export default function App() {
  const { status, model, error, indexing, indexLog, runIndex } = useGraphData();

  return (
    <div className="relative h-full w-full">
      <GraphCanvas model={model} />

      <div className="pointer-events-none absolute inset-0 p-4">
        <StatusPanel
          status={status}
          error={error}
          indexing={indexing}
          indexLog={indexLog}
          onIndex={() => void runIndex()}
        />
      </div>
    </div>
  );
}
