/**
 * @packageDocumentation
 * **Stub package.** Reserves the `@moribashi/cli` name for a future CLI
 * integration (command scaffolding, per-command scope lifecycle, signal
 * handling wired into `app.stop()`). Nothing here is stable — treat every
 * export as `@experimental` with no semver guarantees.
 */

/**
 * Identifies the package at runtime. Returned shape is a placeholder until
 * the CLI integration lands.
 *
 * @experimental
 */
export function diagnostics(): any {
  return {
    module: '@moribashi/cli',
  };
}
