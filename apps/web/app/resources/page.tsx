import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import ResourcesClient from "./resources-client";

export const dynamic = "force-dynamic";

export default async function ResourcesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <ResourcesClient user={user} />;
}
