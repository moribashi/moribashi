export const schema = `
  extend type Query {
    """Look up a product by id."""
    product(id: ID!): Product
    """List all products."""
    products: [Product!]!
  }

  type Product {
    id: ID!
    name: String!
    price: Float!
  }
`;
