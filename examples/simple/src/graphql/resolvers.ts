import type { ResolverMap } from '@moribashi/graphql';
import type BooksService from '../books/books.svc.js';
import type AuthorsService from '../authors/authors.svc.js';

export interface RequestCradle {
  booksService: BooksService;
  authorsService: AuthorsService;
}

export const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    async books(this: RequestCradle) {
      return this.booksService.findAllWithAuthors();
    },
    async authors(this: RequestCradle) {
      return this.authorsService.findAll();
    },
  },
};
