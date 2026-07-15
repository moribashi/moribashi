import type { ResolverMap } from '@moribashi/graphql';
import type UsersService from './users.svc.js';

export interface RequestCradle {
  usersService: UsersService;
}

export const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    async user(this: RequestCradle, _parent: unknown, args: { id: string }) {
      return this.usersService.findById(args.id) ?? null;
    },
    async users(this: RequestCradle) {
      return this.usersService.findAll();
    },
  },
};
