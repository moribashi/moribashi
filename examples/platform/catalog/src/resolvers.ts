import type { ResolverMap } from '@moribashi/graphql';
import type ProductsService from './products.svc.js';

export interface RequestCradle {
  productsService: ProductsService;
}

export const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    async product(this: RequestCradle, _parent: unknown, args: { id: string }) {
      return this.productsService.findById(args.id) ?? null;
    },
    async products(this: RequestCradle) {
      return this.productsService.findAll();
    },
  },
};
