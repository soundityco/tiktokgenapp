import { redirect } from "next/navigation";
import { auth } from "@/auth";
import Studio from "@/components/Studio";

export default async function StudioPage() {
  const session = await auth();
  if (!session?.user) redirect("/");
  return <Studio userName={session.user.name ?? session.user.email ?? ""} />;
}
