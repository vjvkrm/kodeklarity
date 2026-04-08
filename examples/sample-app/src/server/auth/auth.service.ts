const users = new Map<string, { password: string; id: string }>([
  ["demo@example.com", { password: "secret", id: "u-1" }],
]);

function issueToken(userId: string): string {
  return `token:${userId}`;
}

export async function authenticate(email: string, password: string): Promise<{ token: string }> {
  const user = users.get(email);
  if (!user || user.password !== password) {
    throw new Error("invalid credentials");
  }

  return { token: issueToken(user.id) };
}
