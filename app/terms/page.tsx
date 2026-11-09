import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms of Service · Rollout" };
const contact = process.env.CONTACT_EMAIL;

export default function Terms() {
  return (
    <LegalPage title="Terms of Service" updated="October 2026">
      <p>By using Rollout you agree to these terms.</p>

      <h2>The service</h2>
      <p>Rollout helps artists create TikTok photo carousels and lyric videos from their own pictures, audio and videos (kept in a Rollout folder of their own Google Drive), text they write or import, and optionally the hooks of their own TikTok posts. It is provided as is, without warranty, and may change or stop at any time.</p>

      <h2>Your content</h2>
      <p>You keep all rights to your pictures, texts and lyrics. You confirm that you own, or have permission to use, everything you add, and that you respect the rules of TikTok and Google.</p>

      <h2>Accounts and access</h2>
      <p>You sign in with Google. Access is limited to accounts approved by the owner of this app. You are responsible for your account, and you may stop using the service and disconnect your accounts at any time.</p>

      <h2>Acceptable use</h2>
      <p>Do not use the service to break the law, infringe others&apos; rights, or attempt to disrupt or reverse-engineer it.</p>

      <h2>Liability</h2>
      <p>To the extent permitted by law, the owner of this app is not liable for any loss resulting from the use of the service, including loss of data. Keep your own backups (the app has a Backup button).</p>

      <h2>Contact</h2>
      <p>{contact ? <a href={`mailto:${contact}`}>{contact}</a> : "Contact the owner of this app."}</p>
    </LegalPage>
  );
}
