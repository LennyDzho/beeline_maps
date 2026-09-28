import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import AdminClient from "./admin-client";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AdminClient user={user} />;
}
