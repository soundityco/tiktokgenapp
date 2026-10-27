# TkTgen (web)

Générateur de carrousels TikTok pour artistes : connexion Google, un projet par release, photos prises dans ton Google Drive, hooks (saisie manuelle ou OCR de screenshots), lyrics par sections, génération en un clic, export ZIP.

**Stack** : Next.js 15 (App Router) · Auth.js (Google) · Postgres (Neon) · canvas côté navigateur · tesseract.js (OCR dans le navigateur) · Netlify.

## Ce qui est stocké où
- **Photos** : restent dans ton Drive (l'appli ne garde que les identifiants des fichiers).
- **Projets, pools de hooks, lyrics, réglages** : un document JSON par utilisateur dans Postgres (table `workspaces`, créée automatiquement).
- **Screenshots pour l'OCR** : jamais envoyés ni stockés, tout se passe dans le navigateur ; seuls les hooks validés sont enregistrés.

## 1. Google Cloud (une fois)
1. console.cloud.google.com → nouveau projet.
2. *APIs & Services → Library* → activer **Google Drive API**.
3. *OAuth consent screen* → External, statut **Testing**, ajoute vos deux adresses Gmail dans **Test users**.
   Scope utilisé : `drive.readonly` (lecture seule).
4. *Credentials → Create credentials → OAuth client ID* → Web application.
   Authorized redirect URIs :
   - `http://localhost:3000/api/auth/callback/google`
   - `https://TON-SITE.netlify.app/api/auth/callback/google`
5. Copie le Client ID et le Client secret.

> En statut *Testing*, Google expire la connexion environ tous les 7 jours : il suffit de se reconnecter. Pour éviter ça il faudra passer l'app en production (écran « app non vérifiée » acceptable jusqu'à 100 utilisateurs, ou vérification Google).

## 2. Base de données
Crée un projet gratuit sur neon.tech (ou « Netlify DB ») et copie la connection string Postgres.

## 3. Variables d'environnement
Copie `.env.example` en `.env.local` et remplis-le :
```
AUTH_SECRET=        # openssl rand -base64 32
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=
ALLOWED_EMAILS=toi@gmail.com,ami@gmail.com
DATABASE_URL=       # vide en local = fichier .data/workspaces.json
```
Les mêmes variables sont à créer dans Netlify (*Site configuration → Environment variables*).

## 4. Lancer en local
```
npm install
npm run dev        # http://localhost:3000
```
Pour tester l'interface sans Google : ajoute `DEV_FAKE_LOGIN=1` dans `.env.local` (ignoré en production). Les photos Drive nécessitent une vraie connexion Google.

## 5. Déployer
```
git init && git add . && git commit -m "TkTgen"
git remote add origin <ton-repo> && git push -u origin main
```
Netlify → *Add new site → Import from Git*. Le fichier `netlify.toml` gère le reste. N'oublie pas d'ajouter l'URL Netlify aux redirect URIs Google (étape 1.4).

## Utilisation rapide
1. **Picture pools** → clique sur « Slide 1 pictures » → *Add from Google Drive* → choisis un dossier → *Add all*.
2. **Text pools** → écris ou colle tes hooks (un par ligne, `|` = saut de ligne), ou *Extract hooks from screenshots*.
3. **Edit lyrics** → ajoute des sections (Verse 1, Chorus…), choisis celle à afficher avec le menu « Lyrics ».
4. **Generate** (ou touche G) → ajuste dans l'inspecteur → **Download all** (ZIP) ou **Share** sur mobile.

## Limites connues / à faire
- Formats de photos lus : JPG, PNG, WebP, GIF, AVIF (pas HEIC).
- L'OCR télécharge son moteur et sa langue anglaise au premier usage (puis mis en cache par le navigateur).
- Sauvegarde : dernier enregistrement gagnant (prévu pour 1 personne par compte).
- Phase 2 : import des posts via l'API TikTok (filtre par vues). Phase 3 : sous-titres vidéo synchronisés. Le modèle de données réserve déjà `views` (hooks) et `start` (lyrics).
