import { redirect } from "next/navigation";
import { getCurrentUser } from "@/auth/session";
import TodayClient from "./today-client";

export const dynamic = "force-dynamic";

export default async function TodayPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <TodayClient />;
}
