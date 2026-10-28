import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy · TkTgen" };
const contact = process.env.CONTACT_EMAIL;

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="October 2026">
      <p>TkTgen is a small tool that helps music artists build TikTok photo carousels from their own pictures, hooks and lyrics. This page explains what data it uses.</p>

      <h2>What we access</h2>
      <ul>
        <li><b>Google account:</b> your name and email address, to sign you in and keep your projects separate from other users.</li>
        <li><b>Google Drive (read-only):</b> only to list your folders and read the pictures you choose to add. We never modify, delete or upload anything in your Drive.</li>
        <li><b>TikTok (optional, read-only):</b> if you connect your TikTok account, we read the list of your public posts: cover image, caption, and view and like counts. This is used to find the hooks of your best-performing posts. We never post, edit or delete anything on your account.</li>
      </ul>

      <h2>What we store</h2>
      <ul>
        <li>Your projects, text pools, lyrics, settings and the identifiers of the Drive pictures you selected.</li>
        <li>Hooks you validate, with their view counts when they come from TikTok.</li>
        <li>If you connect TikTok: the access token needed to read your posts, kept on our server and never sent to your browser.</li>
      </ul>
      <p>Your pictures stay in your Google Drive. They are processed in your browser and are not copied to our servers. Screenshots used for text detection are processed in your browser and are not uploaded.</p>

      <h2>Sharing</h2>
      <p>We do not sell or share your data with third parties. Data is stored with our hosting and database providers (Netlify and Neon) only to run the service.</p>

      <h2>Your choices</h2>
      <ul>
        <li>Disconnect TikTok at any time from the app. This deletes the stored TikTok token.</li>
        <li>Revoke access at any time from your Google Account (Security, Third-party access) or TikTok settings.</li>
        <li>Ask us to delete all your data{contact ? <> by writing to <a href={`mailto:${contact}`}>{contact}</a></> : <> by contacting the owner of this app</>}.</li>
      </ul>

      <h2>Contact</h2>
      <p>{contact ? <a href={`mailto:${contact}`}>{contact}</a> : "Contact the owner of this app."}</p>
    </LegalPage>
  );
}
