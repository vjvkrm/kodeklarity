'use server'

import { revalidatePath } from "next/cache";
import { createPostService } from "@/lib/services/posts";

export async function createPost(title: string, body: string) {
  await createPostService(title, body);
  revalidatePath("/dashboard");
}

export async function deletePost(id: string) {
  revalidatePath("/dashboard");
}
