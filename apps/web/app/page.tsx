import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import DispatcherDashboard from "./dashboard-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <DispatcherDashboard user={user} />;
}
