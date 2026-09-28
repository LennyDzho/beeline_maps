import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import LoginForm from "./login-form";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const user = await getCurrentUser();
  if (user) redirect("/");

  return (
    <main className="login-page">
      <LoginForm />
    </main>
  );
}
