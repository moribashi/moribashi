// `extend type Query` (not `type Query`) is the federated SDL convention —
// it composes this subgraph's fields into the gateway's supergraph `Query`
// instead of declaring a standalone root type.
export const schema = `
  extend type Query {
    """Look up a user by id."""
    user(id: ID!): User
    """List all users."""
    users: [User!]!
  }

  type User {
    id: ID!
    name: String!
    email: String!
  }
`;
