import type { EvaluationContext } from '@openfeature/server-sdk';
// Anchors the module augmentation below. Type-only, so it adds no runtime
// dependency on @moribashi/web (which is an optional peer).
import type {} from '@moribashi/web';
import type { Flags } from './flags.js';

export { flagsPlugin, type FlagsCradle } from './plugin.js';
export {
  resolveProvider,
  type FlagsPluginOptions,
  type OfrepOptions,
  type InMemoryFlagConfig,
} from './config.js';
export { defaultContextFrom, type PrincipalLike } from './context.js';
export { Flags } from './flags.js';

// Re-export the OpenFeature primitives consumers most commonly need, so a
// custom `provider` or `flags` config can be written against @moribashi/flags
// without a direct @openfeature/server-sdk import.
export {
  OpenFeature,
  InMemoryProvider,
  type Client,
  type Provider,
  type EvaluationContext,
  type EvaluationDetails,
  type JsonValue,
} from '@openfeature/server-sdk';

/**
 * Merge the flags cradle into the web request scope, mirroring how
 * `@moribashi/auth` augments it. Importing `@moribashi/flags` makes
 * `request.scope.cradle.flags` and `.evaluationContext` visible and typed.
 */
declare module '@moribashi/web' {
  interface WebRequestCradle {
    flags: Flags;
    evaluationContext: EvaluationContext;
  }
}

export function diagnostics(): any {
  return {
    module: '@moribashi/flags',
  };
}
