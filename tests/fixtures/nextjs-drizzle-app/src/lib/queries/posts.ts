import { db, posts, users } from "@test/db";

export async function getUserPosts(userId: string) {
  return db.select().from(posts);
}

export async function getPostWithAuthor(postId: string) {
  return db.select().from(posts);
}
