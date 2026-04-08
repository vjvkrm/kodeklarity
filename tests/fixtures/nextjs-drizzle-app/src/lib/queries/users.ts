import { db, users } from "@test/db";

export async function getUsers() {
  return db.select().from(users);
}

export async function getUserById(id: string) {
  return db.select().from(users);
}
