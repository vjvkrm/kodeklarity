import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const posts = pgTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  authorId: text("author_id").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

export const comments = pgTable("comments", {
  id: text("id").primaryKey(),
  body: text("body").notNull(),
  postId: text("post_id").references(() => posts.id),
  authorId: text("author_id").references(() => users.id),
});
