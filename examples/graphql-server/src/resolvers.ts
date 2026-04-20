import type { ResolverMap } from '@moribashi/graphql';
import type GreetService from './greet.svc.js';

/**
 * Shape of the per-request scope cradle available as `this` inside each
 * resolver. `bindResolvers` rewires every resolver so `this` is the Awilix
 * cradle for the request scope — accessing `this.greetService` lazily
 * resolves the service from that scope (SCOPED, so one instance per request).
 */
export interface RequestCradle {
  greetService: GreetService;
}

export const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    hello(this: RequestCradle, _parent, args: { name: string }) {
      return this.greetService.hello(args.name);
    },
    instanceId(this: RequestCradle) {
      return this.greetService.instanceId;
    },
  },
};
