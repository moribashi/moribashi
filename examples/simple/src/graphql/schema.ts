export const schema = `
  type Author {
    id: Int!
    name: String!
  }

  type Book {
    id: Int!
    title: String!
    authorId: Int!
    author: Author
  }

  type Query {
    books: [Book!]!
    authors: [Author!]!
  }
`;
