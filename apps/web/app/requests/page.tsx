import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import RequestsClient from "./requests-client";

export const dynamic = "force-dynamic";

export default async function RequestsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <RequestsClient user={user} />;
}
