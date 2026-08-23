/**
 * `GET /api/node/:id` for the current selection.
 *
 * Phase F split the selection surface into two independent panels (node + code)
 * that both need the same payload, so the fetch was lifted out of the node
 * panel and into the shell: one request per selection, two readers, and the
 * code panel no longer has to wait for the node panel to hand it a span.
 *
 * Directories are answered locally — `dirs[]` entries are synthesized by the
 * graph payload and have no row behind the endpoint, so asking would 404.
 */
import { useEffect, useState } from 'react';

import { DIRECTORY_KIND, type ModelNode } from '@/graph/model';
import { fetchNode, type NodeDetail } from '@/lib/api';

export interface NodeDetailState {
  detail: NodeDetail | null;
  loading: boolean;
  error: string | null;
}

export function useNodeDetail(node: ModelNode | null): NodeDetailState {
  const [state, setState] = useState<NodeDetailState>({
    detail: null,
    loading: false,
    error: null,
  });
  const id = node?.id ?? null;
  const isDirectory = node?.kind === DIRECTORY_KIND;

  useEffect(() => {
    if (!id || isDirectory) {
      setState({ detail: null, loading: false, error: null });
      return;
    }
    const controller = new AbortController();
    setState({ detail: null, loading: true, error: null });
    void fetchNode(id, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) setState({ detail: payload, loading: false, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          detail: null,
          loading: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => controller.abort();
  }, [id, isDirectory]);

  return state;
}
