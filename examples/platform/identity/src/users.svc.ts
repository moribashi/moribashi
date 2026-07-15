export interface User {
  id: string;
  name: string;
  email: string;
}

const USERS: User[] = [
  { id: '1', name: 'Ada Lovelace', email: 'ada@example.com' },
  { id: '2', name: 'Grace Hopper', email: 'grace@example.com' },
];

export default class UsersService {
  findAll(): User[] {
    return USERS;
  }

  findById(id: string): User | undefined {
    return USERS.find((user) => user.id === id);
  }
}
