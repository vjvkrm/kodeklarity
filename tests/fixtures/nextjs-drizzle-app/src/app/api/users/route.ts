import { getUsers } from "@/lib/queries/users";

export async function GET() {
  const users = await getUsers();
  return Response.json(users);
}

export async function POST(req: Request) {
  const body = await req.json();
  return Response.json({ created: true });
}
