import type { Metadata } from "next";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Privacy Policy · Rollout" };
const contact = process.env.CONTACT_EMAIL;

export default function Privacy() {
  return (
    <LegalPage title="Privacy Policy" updated="November 2026">
      <p>Rollout is a small tool that helps music artists build TikTok photo carousels from their own pictures, hooks and lyrics, and short videos with their lyrics on the official audio. This page explains what data it uses.</p>

      <h2>What we access</h2>
      <ul>
        <li><b>Google account:</b> your name and email address, to sign you in and keep your projects separate from other users.</li>
        <li><b>Google Drive (only the files Rollout creates):</b> Rollout keeps your work in a “Rollout” folder of your own Drive (your photo lists, official audio, camera videos and their working copies, fonts, colour LUTs, and the exports you send to your phone), so you find them on any device. It reads, renames, moves and deletes only the files and folders it created there. It cannot see or open any other file of your Drive.</li>
        <li><b>TikTok (optional, read-only):</b> if you connect your TikTok account, we read the list of your public posts: cover image, caption, and view and like counts. This is used to find the hooks of your best-performing posts. We never post, edit or delete anything on your account.</li>
      </ul>

      <h2>What we store</h2>
      <ul>
        <li>Your projects, text pools, lyrics, settings, and the identifiers of the files Rollout put in your Drive.</li>
        <li>For videos: the lyrics you paste, the timing of each word on the official audio, and the sync, trim and framing settings.</li>
        <li>Hooks you validate, with their view counts when they come from TikTok.</li>
        <li>Earlier versions of these data (at most one every 10 minutes, the last 30), so you can restore them.</li>
        <li>If you connect TikTok: the access token needed to read your posts, kept encrypted on our server and never sent to your browser.</li>
      </ul>

      <h2>What stays on your device</h2>
      <p>Your pictures, official audio, camera videos and fonts go from your device to your own Google Drive, and are kept in your browser's storage on this device. They are never copied to our servers. Screenshots used for text detection are processed in your browser and are not uploaded.</p>
      <p>Everything done with your files (sync with the official audio, recognition of the sung words, conversion of camera formats, export of the carousel or the video) runs in your browser.</p>
      <p>One exception, only when you use “Send to my phone”: the exported files go through our database for a few minutes so your phone can download them, then are deleted (at the latest after 10 minutes). Big files go through a direct link between your devices or through your own Drive instead.</p>
      <p>To do this, your browser downloads, once, software components from public servers: a speech-recognition model from Hugging Face, and the libraries that run it and convert videos from jsDelivr. These servers see a request from your browser (like for any website) but receive none of your files.</p>

      <h2>Google user data</h2>
      <p>Rollout's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noreferrer">Google API Services User Data Policy</a>, including the Limited Use requirements. Google data is used only to provide the features described above, is never used for advertising, is never sold, and is never read by people except with your consent (for example to help you with a problem you report) or when the law requires it.</p>

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
