import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import ReportsClient from "./reports-client";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <ReportsClient user={user} />;
}
