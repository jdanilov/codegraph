/**
 * Reference plugin — the contract example, and the test vehicle for the
 * enable / disable / options path. It does nothing observable.
 *
 * A resolver plugin IS a `FrameworkResolver` (see `../types`) that gates itself
 * on project config instead of on files found in the tree. The whole contract:
 *
 *   1. Export a `const` implementing `FrameworkResolver`.
 *   2. Its `name` is BOTH the registry name and the `codegraph.json` config key,
 *      so `plugins.<name>` turns it on and `plugins.disable: ["<name>"]` off.
 *   3. `detect()` returns `isPluginEnabled(context.getProjectRoot(), NAME)` —
 *      nothing else. A project with no `plugins` entry must get exactly the
 *      behavior it had before the plugin existed.
 *   4. Read options with `getPluginOptions<Options>(root, NAME)`, and validate
 *      them yourself: warn-and-skip a bad value, never throw.
 *   5. Add it to `PLUGIN_RESOLVERS` in `./index.ts`.
 *
 * From there the plugin uses the ordinary resolver hooks — `claimsReference` to
 * opt a dynamic reference name past the "no node has this name" pre-filter,
 * `resolve` to turn it into an edge, `extract`/`postExtract` for synthetic
 * nodes. This one implements none of them beyond the required `resolve`.
 */
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { getPluginOptions, isPluginEnabled } from './plugin-config';

/** Config key and registry name for this plugin. */
export const NOOP_PLUGIN_NAME = 'noop';

/** Options accepted under `plugins.noop` in `codegraph.json`. */
export interface NoopPluginOptions {
  /**
   * Free-form label, echoed back by `getNoopPluginLabel`. Exists purely so the
   * options path has something to assert on; nothing reads it in production.
   */
  label?: string;
}

/**
 * The plugin's validated `label` option, or `undefined` when unset, not a
 * string, or the plugin is off. Illustrates the per-option validation a real
 * plugin owns.
 */
export function getNoopPluginLabel(projectRoot: string): string | undefined {
  const options = getPluginOptions<NoopPluginOptions>(projectRoot, NOOP_PLUGIN_NAME);
  const label = options.label;
  return typeof label === 'string' && label.length > 0 ? label : undefined;
}

export const noopPlugin: FrameworkResolver = {
  name: NOOP_PLUGIN_NAME,

  detect(context: ResolutionContext): boolean {
    try {
      return isPluginEnabled(context.getProjectRoot(), NOOP_PLUGIN_NAME);
    } catch {
      return false;
    }
  },

  // Enabled or not, this plugin resolves nothing — being listed among the
  // detected frameworks is its entire observable effect.
  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },
};
