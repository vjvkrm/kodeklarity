import { login } from "./api";

export type LoginRequest = {
  email: string;
  password: string;
};

export async function onSubmit(input: LoginRequest): Promise<string> {
  const response = await login(input.email, input.password);
  return response.token;
}
