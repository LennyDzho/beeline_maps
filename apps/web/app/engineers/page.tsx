import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import EngineersClient from "./engineers-client";

export const dynamic = "force-dynamic";

export default async function EngineersPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <EngineersClient user={user} />;
}
