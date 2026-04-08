import { db, users } from "@test/db";

export async function authenticateUser(email: string, password: string) {
  const user = await db.select().from(users);
  return user;
}
