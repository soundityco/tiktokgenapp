# TkTgen : contexte du projet

Réponds en français. Andy (Angers) construit TkTgen avec un ami : une web app pour artistes musicaux qui crée des carrousels TikTok (hooks, paroles, photos Drive) et un studio vidéo (prise caméra synchronisée sur l'audio officiel, paroles incrustées).

## Stack
- Next.js 15 (App Router), TypeScript 5 (ne pas passer à 7), Auth.js (next-auth beta) avec login Google + `drive.readonly`.
- Données : Neon Postgres (table `workspaces`, un JSON par email, compare-and-swap sur `rev`). Sans `DATABASE_URL`, repli sur `.data/workspaces.json` (badge « Local file »).
- Déploiement : GitHub + Netlify (`@netlify/plugin-nextjs`, `publish = ".next"` dans netlify.toml, ne pas définir de Base directory).
- Tests : `npm test` (vitest). Typecheck : `npm run typecheck`.
- Ne jamais lire ni afficher `.env.local`.

## Architecture utile
- `components/Studio.tsx` : carrousel. `components/VideoStudio.tsx` : studio vidéo. `components/Inspector.tsx` : réglages de texte du carrousel. `components/CaptionStyle.tsx` : même chose pour les paroles de la vidéo.
- `lib/render.ts` : rendu canvas (`drawStyledText`). `lib/types.ts` : modèle de données.
- Médias (audio, vidéo, polices) : IndexedDB local (`lib/idb.ts`), jamais envoyés au serveur.
- Synchro audio caméra ↔ officiel : `lib/syncAudio.ts` (spectrogramme log-mel + corrélation FFT, vote de pics, score de confiance).
- Paroles depuis l'audio : `public/asr/worker.js` (Whisper via transformers.js 3.7.6 chargé depuis jsDelivr, modèles Hugging Face) → `lib/transcribe.ts` → `lib/lyricsAlign.ts` (alignement sur les paroles écrites, découpage mot à mot / phrase par phrase). Les mots sont dans `project.lyricWords` (temps absolus dans l'audio).
- i18n : `lib/fr.ts` (dictionnaire clé = texte anglais). Un test vérifie que chaque `t("…")` a une traduction française : en ajouter une à chaque nouveau texte.

## Design
- Garder le look « éditorial » v0.3 actuel (pas la version Aurare v0.4). Interface sobre, cohérente, pas de look « SaaS généré par IA ».

## État et à faire
- Fait : synchro automatique fiable, notification de fin de synchro, bande « vidéo dispo » sur la waveform, trim live, paroles depuis l'audio, studio texte vidéo avec polices chargées.
- Pas encore testé en conditions réelles : le modèle vocal (téléchargement Hugging Face bloqué dans l'environnement de dev précédent).
- À faire / idées : édition des mots générés, presets de style pour la vidéo, verrouillage de slide, export par lot, légende + hashtags par projet, avis de reconnexion Google.
- Import TikTok : en attente de la validation de l'app par TikTok.
