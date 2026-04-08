import { loginAction } from "@/lib/actions/auth";

export default function LoginPage() {
  return <form action={loginAction}><button>Login</button></form>;
}
