import type { EvaluationContext } from '@openfeature/server-sdk';

/**
 * The subset of a principal this package reads to build an evaluation context.
 * Deliberately structural (not an import of `@moribashi/auth`'s `Principal`) so
 * flags has no dependency on auth — any object with these fields works, and an
 * app without auth simply yields the empty context.
 */
export type PrincipalLike =
  | {
      identity?: string;
      /** Tenant/issuer id, if the principal carries one. */
      tid?: number;
      /** Principal type ("USER", "SERVICE", …), if present. */
      type?: string;
    }
  | undefined
  | null;

/**
 * Default principal → evaluation context mapping: the identity becomes the
 * `targetingKey` (so per-user rollouts work out of the box), with `tid`/`type`
 * carried through as targeting attributes when present. Anonymous / absent
 * principals yield an empty context.
 */
export function defaultContextFrom(principal: PrincipalLike): EvaluationContext {
  if (principal && typeof principal.identity === 'string') {
    const ctx: EvaluationContext = { targetingKey: principal.identity };
    if (typeof principal.tid === 'number') ctx.tid = principal.tid;
    if (typeof principal.type === 'string') ctx.type = principal.type;
    return ctx;
  }
  return {};
}
