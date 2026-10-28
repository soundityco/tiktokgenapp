import Link from "next/link";
import Logo from "./Logo";

export default function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <main style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px 64px", lineHeight: 1.6 }}>
      <div className="row" style={{ marginBottom: 24 }}>
        <Logo size={32} />
        <Link href="/" style={{ color: "var(--text)", fontWeight: 700, textDecoration: "none", fontSize: 18 }}>TkTgen</Link>
      </div>
      <h1 style={{ marginBottom: 4 }}>{title}</h1>
      <p className="muted" style={{ marginTop: 0 }}>Last updated: {updated}</p>
      {children}
    </main>
  );
}
