import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import VisitClient from "./visit-client";

export const dynamic = "force-dynamic";

export default async function VisitPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <VisitClient />;
}
