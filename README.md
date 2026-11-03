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
TIKTOK_CLIENT_KEY=      # optionnel, voir « Import TikTok »
TIKTOK_CLIENT_SECRET=
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

## Import TikTok (optionnel)
1. developers.tiktok.com → *Manage apps* → crée une app. Ajoute les produits **Login Kit** et **Display API** avec les scopes `user.info.basic` et `video.list` (l'interface de TikTok change souvent : cherche ces noms).
2. Redirect URI à déclarer (HTTPS obligatoire, donc à tester sur le site Netlify) :
   `https://TON-SITE.netlify.app/api/tiktok/callback`
3. Tant que l'app est en **sandbox**, ajoute vos comptes TikTok comme utilisateurs de test (*Target users*) : pas de validation TikTok nécessaire.
4. Copie *Client key* et *Client secret* dans les variables Netlify `TIKTOK_CLIENT_KEY` et `TIKTOK_CLIENT_SECRET`, puis relance un déploiement.
5. Dans l'appli : *Extract hooks from screenshots* → onglet **From my TikTok account** → *Connect TikTok* → *Load my posts* → choisis « My best posts » (N meilleurs) ou « at least X views » → *Start*. Les vues de chaque hook sont enregistrées ; la case **Favor top hooks** tire les hooks proportionnellement à leurs vues.

Limites : l'API renvoie la **couverture** de chaque post (la slide 1, donc le hook), pas les slides suivantes. Si vos carrousels photo n'apparaissent pas dans `video.list`, garde l'import par screenshots. Les jetons TikTok sont stockés côté serveur (table `tiktok_tokens`), jamais envoyés au navigateur.

## Nouveautés v0.4
- **Gestion complète des slides** : insérer après la slide sélectionnée, dupliquer, déplacer, supprimer, jusqu'à 35 slides.
- **Verrou** par slide : une slide verrouillée conserve son texte et sa photo lors d'une régénération.
- **Annuler / rétablir** (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) et boutons dans la barre d'outils.
- **Pré-vol** avant génération : listes vides, slides sans source, risque de photos ou de textes répétés.
- **Export avec progression**, annulation et fichier `captions.txt` dans le ZIP.
- **Mobile** : onglets Slides / Listes / Style, défilement tactile corrigé et champs adaptés à iOS.
- **Drive** : recherche dans tout le Drive et fil d'Ariane cliquable.
- **Hooks** : les vues TikTok enregistrées sont visibles dans l'éditeur de liste.

## Nouveautés v0.5
**Récap.** Le studio vidéo n'est plus une fenêtre posée sur le carrousel : un switch `Carrousel / Vidéo` dans l'en-tête permet de passer d'un studio à l'autre, à côté du sélecteur de release, avec sauvegarde forcée avant chaque bascule. Chaque release peut maintenant garder plusieurs clips (`Video 1`, `Video 2`…) avec leur propre audio officiel, prise caméra, segment, cadrage et synchro ; les paroles chronométrées et le style restent communs à la release. Les anciens projets sont migrés automatiquement : l'ancien réglage vidéo unique devient le premier clip et retrouve ses fichiers déjà importés.

Le nettoyage a été revu : retirer l'audio ou la vidéo efface les buffers, la forme d'onde, l'offset et la synchro, supprime la copie locale et décharge le lecteur ; changer de clip ou de release remet le studio à zéro et annule les analyses en cours, et supprimer une release supprime les médias de tous ses clips. Les imports, suppressions et synchros sont enregistrés immédiatement, et l'export porte le nom du clip. Les fichiers restent sur l'appareil ; la synchro automatique reste le point à stabiliser.

- **Studio vidéo** : importe l'audio officiel de la sortie, recadre-le (10/15/20/30 s ou à la main sur la forme d'onde), importe la vidéo tournée à la caméra : l'appli retrouve automatiquement où la prise de son se situe dans l'audio officiel (voir « Synchro automatique » ci-dessous), puis exporte un clip vertical `.webm` avec l'audio officiel et les paroles incrustées.
- **Paroles synchronisées** : les instants de chaque ligne sont placés une fois (automatiquement ou à la main) et restent enregistrés avec la section, donc réutilisables pour toutes les vidéos de la release.
- **Deux studios, un seul en-tête** : le sélecteur de release reste en haut et un switch `Carrousel / Vidéo` permet de passer d'un studio à l'autre sans rechargement. La sauvegarde est forcée avant chaque bascule, et les deux studios travaillent sur le même workspace : aucune donnée n'est perdue.
- **Plusieurs vidéos par release** : chaque release garde ses clips (`Video 1`, `Video 2`…) avec leur propre audio officiel, prise caméra, recadrage et synchro ; les paroles chronométrées et le style restent communs à la release.
- **Enregistrement immédiat** : les imports, suppressions et synchros sont sauvegardés tout de suite, et chaque bascule de studio force l'enregistrement au lieu d'attendre le délai habituel.
- **Paroles par slide** : chaque slide « Lyrics » peut lire sa propre section (couplet, refrain…) au lieu d'une section unique pour tout le projet.
- **Préréglages de style** nommés, réutilisables sur tous les projets.
- **Réordonner les slides en glisser-déposer** (poignée ⠿).
- **Vues TikTok mises à jour** en un clic depuis l'éditeur d'une liste de hooks.
- **Annuler / rétablir** conservé après un rechargement de l'onglet.
- Pré-vol : signale aussi les textes trop longs pour leur style.
- Correction : « Favor my best hooks » ne désactive plus « No repeats until everything was used ».

## Utilisation rapide
1. **Picture pools** → clique sur « Slide 1 pictures » → *Add from Google Drive* → choisis un dossier → *Add all*.
2. **Text pools** → écris ou colle tes hooks (un par ligne, `|` = saut de ligne), ou *Extract hooks from screenshots*.
3. **Edit lyrics** → ajoute des sections (Verse 1, Chorus…), choisis celle à afficher avec le menu « Lyrics ».
4. **Generate** (ou touche G) → ajuste dans l'inspecteur → **Download all** (ZIP) ou **Share** sur mobile.
5. Pour garder une slide telle quelle, ouvre son menu (⋯) et choisis **Lock slide** avant de régénérer.

## Langue
L'interface existe en **français et en anglais** : la langue du navigateur est détectée, et tu peux la changer dans ⚙ (en haut à droite). Les textes sont dans `lib/fr.ts` (clé = texte anglais utilisé dans le code).

## Développement
```
npm test          # tests automatiques (génération, formats d'image, OCR, traductions, sauvegarde…)
npm run typecheck
```
Un test vérifie aussi que chaque texte de l'interface a sa traduction française.

## Limites connues / à faire
- Formats de photos : le vrai format est détecté dans le fichier (pas son extension) puis converti dans le navigateur : JPG, PNG, WebP, GIF, BMP, AVIF, **HEIC/HEIF**, TIFF. Le HEIC est plus lent à décoder (un à la fois).
- L'OCR est hébergé par l'appli elle-même (`public/ocr`, copié automatiquement par `npm install`) : aucun CDN externe.
- Si tu ouvres l'appli sur deux appareils ou onglets, une bannière te prévient quand l'autre a enregistré avant toi (« Charger la dernière version » ou « Garder ma version ») : plus d'écrasement silencieux.
- Studio vidéo : les fichiers importés restent sur l'appareil (IndexedDB), un audio et une vidéo par clip, rien n'est envoyé au serveur. Retirer l'audio ou la vidéo supprime aussi la copie locale ; supprimer un projet supprime les médias de tous ses clips. L'export produit un `.webm` (pas de MP4), limité à 30 s par la durée du segment. Si le navigateur ne sait pas décoder la piste audio du fichier (fréquent avec les MOV/MP4 de téléphone), la synchro relit la bande-son via le lecteur vidéo en temps réel : compte alors jusqu'à ~45 s d'attente. Précision de la synchro : environ 0,1 s (boutons ±0,1 pour affiner à l'oreille).

## Synchro automatique (audio de la caméra ↔ audio officiel)
- **Principe** : la prise de son du téléphone et le morceau officiel sont transformés en spectrogrammes (32 bandes, 40 images/s, échelle log) dont on retire les variations lentes (gain automatique, pièce, haut-parleur). Des extraits de 6 s de la prise sont glissés sur **tout** le morceau (corrélation FFT sur toutes les bandes à la fois) : accords, mélodie, basse et timbre font ressortir la bonne position. Chaque extrait vote pour un décalage, pondéré par l'écart avec son meilleur concurrent ; on affine ensuite sur la zone où la musique joue vraiment (quelqu'un qui parle au début ne fausse rien).
- **Refrain copié-collé** : si plusieurs positions sont identiques, celle qui fait correspondre le **segment choisi** (recadrage) l'emporte.
- **Confiance** : ≥ 70 % = fiable ; entre 40 et 70 % = « vérifie à l'oreille » ; < 40 % = aucune correspondance, le décalage n'est pas modifié.
- **Plan B** : si le navigateur ne sait pas décoder l'audio d'un MOV/MP4 de téléphone, la vidéo est lue en arrière-plan (silencieuse) pour en capter le son brut : ~1 minute max, précision ~0,05 s.
- Le code est dans `lib/syncAudio.ts` (fonctions pures), testé par `tests/syncAudio.test.ts`.

## Alertes `npm audit`
Deux alertes concernent PostCSS, embarqué dans Next.js : elles portent sur du CSS fourni par un attaquant, que l'appli ne traite jamais. Les corriger demande Next 16 (changement majeur), à faire plus tard.
