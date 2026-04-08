import { db, posts } from "@test/db";

export async function createPostService(title: string, body: string) {
  return db.insert(posts).values({ title, body });
}
