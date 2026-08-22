/**
 * Resolver plugin registry.
 *
 * Plugins are in-tree modules, selected and configured per project by
 * `codegraph.json` — never loaded from a user-supplied JS path. Three reasons,
 * and the first is a hard constraint rather than a preference:
 *
 *   1. Worker threads. `extraction/parse-worker.ts` statically imports the
 *      framework registry and filters it by NAME. A dynamically-loaded module
 *      would simply not exist inside a worker; a statically-imported one
 *      populates the registry on module load in every thread, and the
 *      config-driven enable list travels as plain strings.
 *   2. Security. Executing arbitrary user JS during indexing is incompatible
 *      with the repo's path-refusal model.
 *   3. Reviewability. In-tree plugins carry tests.
 *
 * Registration is this STATIC ARRAY rather than a side-effecting
 * `registerFrameworkResolver()` call at module load. `registerFrameworkResolver`
 * stays the public entry point for callers embedding CodeGraph as a library,
 * but for in-tree plugins a static list is strictly better: registry contents
 * become a pure function of the import graph (identical in the main thread and
 * in every worker, no import-order dependence), the ordering is reviewable in
 * one place, and there is no module whose import has a side effect a bundler or
 * a tree-shaker could drop.
 *
 * Enablement is NOT expressed here. Every plugin ships registered and off; its
 * `detect()` asks `plugin-config.ts` whether the project opted in. So a project
 * with no `plugins` key in `codegraph.json` behaves exactly as it did before
 * any plugin existed.
 */
import type { FrameworkResolver } from '../types';
import { noopPlugin } from './noop';
import { namespaceProxyPlugin } from './namespace-proxy';
import { layerChainPlugin } from './layer-chain';
import { eventBusPlugin } from './event-bus';

/**
 * Every in-tree plugin, in registration order. Appended to the built-in
 * framework resolvers by `../frameworks/index.ts`.
 */
export const PLUGIN_RESOLVERS: readonly FrameworkResolver[] = [
  noopPlugin,
  namespaceProxyPlugin,
  layerChainPlugin,
  eventBusPlugin,
];

export {
  isPluginEnabled,
  getPluginOptions,
  getDisabledResolverNames,
  clearPluginConfigCache,
  type PluginOptions,
} from './plugin-config';

export {
  noopPlugin,
  NOOP_PLUGIN_NAME,
  getNoopPluginLabel,
  type NoopPluginOptions,
} from './noop';

export { namespaceProxyPlugin, NAMESPACE_PROXY_PLUGIN_NAME } from './namespace-proxy';
export { layerChainPlugin, LAYER_CHAIN_PLUGIN_NAME } from './layer-chain';
export { eventBusPlugin, EVENT_BUS_PLUGIN_NAME } from './event-bus';
