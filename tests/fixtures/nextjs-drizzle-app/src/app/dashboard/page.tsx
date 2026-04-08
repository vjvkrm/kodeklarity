import { getUserPosts } from "@/lib/queries/posts";

export default async function DashboardPage() {
  const posts = await getUserPosts("user-1");
  return <div>{posts.length} posts</div>;
}
