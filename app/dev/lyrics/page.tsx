import { notFound } from "next/navigation";
import LyricsBench from "@/components/dev/LyricsBench";

/** Dev only: the lyrics placing run on a file, with the app's own code (no account, nothing saved). */
export default function Page() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LyricsBench />;
}
