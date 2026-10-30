import Link from "next/link";
import Logo from "./Logo";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main className="prose">
      <Link href="/" className="row" style={{ textDecoration: "none", marginBottom: "var(--s4)" }}>
        <Logo size={28} /><span className="label">TkTgen</span>
      </Link>
      <h1>{title}</h1>
      <p className="label">Last updated · {updated}</p>
      {children}
    </main>
  );
}
