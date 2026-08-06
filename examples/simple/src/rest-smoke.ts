// Smoke test for graphqlPlugin({ rest: true }) — no postgres needed.
import { asClass, createApp, Lifetime } from '@moribashi/core';
import { graphqlPlugin, type ResolverMap } from '@moribashi/graphql';
import { webPlugin } from '@moribashi/web';

class BooksService {
  private books = [
    { id: 1, title: 'Dune', authorId: 1 },
    { id: 2, title: 'Hyperion', authorId: 2 },
  ];

  findAll() {
    return this.books;
  }

  findById(id: number) {
    return this.books.find((b) => b.id === id) ?? null;
  }

  add(title: string) {
    const book = { id: this.books.length + 1, title, authorId: 0 };
    this.books.push(book);
    return book;
  }
}

interface Cradle {
  booksService: BooksService;
}

const schema = `
  type Book {
    id: Int!
    title: String!
    authorId: Int!
  }

  type Query {
    books: [Book!]!
    book(id: Int!): Book
  }

  type Mutation {
    addBook(title: String!): Book!
  }
`;

const resolvers: ResolverMap<Cradle> = {
  Query: {
    async books(this: Cradle) {
      return this.booksService.findAll();
    },
    async book(this: Cradle, _parent, args: { id: number }) {
      return this.booksService.findById(args.id);
    },
  },
  Mutation: {
    async addBook(this: Cradle, _parent, args: { title: string }) {
      return this.booksService.add(args.title);
    },
  },
};

const app = createApp();
app.use(webPlugin({ port: 3123, host: '127.0.0.1' }));
const customRest = process.env.CUSTOM_REST === '1';
app.use(
  graphqlPlugin({
    schema,
    resolvers,
    graphiql: true,
    rest: customRest
      ? {
          basePath: '/rest',
          openApi: { title: 'Books API', version: '1.2.3' },
          swaggerUi: false,
        }
      : true,
  }),
);

app.container.register({
  booksService: asClass(BooksService).setLifetime(Lifetime.SINGLETON),
});

await app.start();
console.log('SMOKE_READY');

process.on('SIGINT', async () => {
  await app.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await app.stop();
  process.exit(0);
});
