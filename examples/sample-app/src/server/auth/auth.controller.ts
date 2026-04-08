import { authenticate } from "./auth.service";

export type AuthResponse = {
  token: string;
};

export async function loginController(email: string, password: string): Promise<AuthResponse> {
  return authenticate(email, password);
}
