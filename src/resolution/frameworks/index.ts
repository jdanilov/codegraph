/**
 * Framework Resolver Registry
 *
 * Manages framework-specific resolvers.
 */

import { FrameworkResolver, ResolutionContext } from '../types';
import type { Language } from '../../types';
import { drupalResolver } from './drupal';
import { laravelResolver } from './laravel';
import { expressResolver } from './express';
import { nestjsResolver } from './nestjs';
import { reactResolver } from './react';
import { svelteResolver } from './svelte';
import { vueResolver } from './vue';
import { astroResolver } from './astro';
import { djangoResolver, flaskResolver, fastapiResolver } from './python';
import { railsResolver } from './ruby';
import { springResolver } from './java';
import { playResolver } from './play';
import { goResolver } from './go';
import { goframeResolver } from './goframe';
import { rustResolver } from './rust';
import { aspnetResolver } from './csharp';
import { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
import { swiftObjcBridgeResolver } from './swift-objc';
import { reactNativeBridgeResolver } from './react-native';
import { expoModulesResolver } from './expo-modules';
import { fabricViewResolver } from './fabric';
import { cicsResolver } from './cics';
import { terraformResolver } from './terraform';
import { PLUGIN_RESOLVERS } from '../plugins';
import { getDisabledResolverNames } from '../plugins/plugin-config';

/**
 * All registered framework resolvers
 */
const FRAMEWORK_RESOLVERS: FrameworkResolver[] = [
  // PHP
  laravelResolver,
  drupalResolver,
  // JavaScript/TypeScript
  expressResolver,
  nestjsResolver,
  reactResolver,
  svelteResolver,
  vueResolver,
  astroResolver,
  // Python
  djangoResolver,
  flaskResolver,
  fastapiResolver,
  // Ruby
  railsResolver,
  // Java
  springResolver,
  playResolver,
  // Go
  goResolver,
  goframeResolver,
  // Rust
  rustResolver,
  // C#
  aspnetResolver,
  // Swift
  swiftUIResolver,
  uikitResolver,
  vaporResolver,
  // Swift ↔ Objective-C cross-language bridging (mixed iOS apps)
  swiftObjcBridgeResolver,
  // React Native JS ↔ native bridge (legacy + TurboModules)
  reactNativeBridgeResolver,
  // Expo Modules — Function/AsyncFunction/Property DSL on Swift/Kotlin
  expoModulesResolver,
  // React Native Fabric / Codegen view components — TS spec → component nodes
  fabricViewResolver,
  // CICS pseudo-conversational TRANSID hops (COBOL)
  cicsResolver,
  // Terraform / OpenTofu — disambiguate var/local/module/resource refs to same-dir module
  terraformResolver,
  // Config-selected plugins (`src/resolution/plugins/`). Registered statically
  // — see that module's header for why — and each one gates itself on the
  // project's `codegraph.json` inside its own `detect()`, so a project that
  // configures none of them is unaffected by their presence here.
  ...PLUGIN_RESOLVERS,
];

/**
 * Names a project turned off through `plugins.disable` in `codegraph.json`.
 * Empty (and allocation-free) for a project with no `plugins` key.
 */
function disabledFor(projectRoot: string | undefined): ReadonlySet<string> | null {
  if (!projectRoot) return null;
  try {
    const disabled = getDisabledResolverNames(projectRoot);
    return disabled.size > 0 ? disabled : null;
  } catch {
    return null;
  }
}

/**
 * Get all framework resolvers.
 *
 * Pass `projectRoot` to honor that project's `plugins.disable` list. Called
 * without one — the pre-existing signature, and what every caller that already
 * filters by detected-framework NAME does — it returns the full registry
 * unchanged, since a disabled resolver never made it into that name list in the
 * first place (`detectFrameworks` drops it).
 */
export function getAllFrameworkResolvers(projectRoot?: string): FrameworkResolver[] {
  const disabled = disabledFor(projectRoot);
  if (!disabled) return FRAMEWORK_RESOLVERS;
  return FRAMEWORK_RESOLVERS.filter((r) => !disabled.has(r.name));
}

/**
 * Get a resolver by name
 */
export function getFrameworkResolver(name: string): FrameworkResolver | undefined {
  return FRAMEWORK_RESOLVERS.find((r) => r.name === name);
}

/**
 * Detect which frameworks are used in a project.
 *
 * This is the single gate every downstream consumer passes through — extraction
 * and the parse workers both filter the registry by the NAMES this returns — so
 * honoring `plugins.disable` here is what actually turns a resolver off
 * everywhere. Plugins gate themselves inside their own `detect()`.
 */
export function detectFrameworks(context: ResolutionContext): FrameworkResolver[] {
  let projectRoot: string | undefined;
  try {
    projectRoot = context.getProjectRoot();
  } catch {
    projectRoot = undefined;
  }
  const disabled = disabledFor(projectRoot);

  return FRAMEWORK_RESOLVERS.filter((resolver) => {
    if (disabled?.has(resolver.name)) return false;
    try {
      return resolver.detect(context);
    } catch {
      return false;
    }
  });
}

/**
 * Filter a list of detected frameworks down to ones that apply to a given language.
 * Frameworks without an explicit `languages` list are treated as universal.
 *
 * Deliberately not plugin-aware: it filters a list the caller already obtained
 * from `detectFrameworks` (or by name from it), so anything `plugins.disable`
 * turned off is gone before it gets here.
 */
export function getApplicableFrameworks(
  detected: FrameworkResolver[],
  language: Language
): FrameworkResolver[] {
  return detected.filter(
    (fw) => !fw.languages || fw.languages.includes(language)
  );
}

/**
 * Register a custom framework resolver
 */
export function registerFrameworkResolver(resolver: FrameworkResolver): void {
  // Remove existing resolver with same name
  const index = FRAMEWORK_RESOLVERS.findIndex((r) => r.name === resolver.name);
  if (index !== -1) {
    FRAMEWORK_RESOLVERS.splice(index, 1);
  }
  FRAMEWORK_RESOLVERS.push(resolver);
}

// Re-export framework resolvers
export { drupalResolver } from './drupal';
export { laravelResolver, FACADE_MAPPINGS } from './laravel';
export { expressResolver } from './express';
export { nestjsResolver } from './nestjs';
export { reactResolver } from './react';
export { svelteResolver } from './svelte';
export { vueResolver } from './vue';
export { astroResolver } from './astro';
export { djangoResolver, flaskResolver, fastapiResolver } from './python';
export { railsResolver } from './ruby';
export { springResolver } from './java';
export { playResolver } from './play';
export { goResolver } from './go';
export { goframeResolver } from './goframe';
export { rustResolver } from './rust';
export { aspnetResolver } from './csharp';
export { swiftUIResolver, uikitResolver, vaporResolver } from './swift';
export { swiftObjcBridgeResolver } from './swift-objc';
export { reactNativeBridgeResolver } from './react-native';
export { expoModulesResolver } from './expo-modules';
export { fabricViewResolver } from './fabric';
