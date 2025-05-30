interface User {
  id: string;
  username: string;
  passwordHash: string;
}

const users: User[] = [];

export async function findUserByUsername(username: string) {
  // Simulating a database lookup
  return users.find((user) => user.username === username) || null;
}

export function createUser(username: string, passwordHash: string) {
  // Simulating a database insert
  const newUser = {
    id: Math.floor(Math.random() * 1000).toString(),
    username,
    passwordHash,
  };
  users.push(newUser);
  return newUser;
}
