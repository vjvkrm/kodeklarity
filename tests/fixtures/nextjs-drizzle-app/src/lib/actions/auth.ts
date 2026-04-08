'use server'

import { revalidatePath } from "next/cache";
import { authenticateUser } from "@/lib/services/auth";

export async function loginAction(formData: FormData) {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;
  await authenticateUser(email, password);
  revalidatePath("/dashboard");
}

export async function logoutAction() {
  revalidatePath("/");
}
