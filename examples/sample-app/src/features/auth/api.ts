import { loginController } from "../../server/auth/auth.controller";

export type LoginResponse = {
  token: string;
};

export async function login(email: string, password: string): Promise<LoginResponse> {
  return loginController(email, password);
}
