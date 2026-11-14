# Rollout : ce que fait l'app

La liste de tout ce que Rollout propose, du point de vue de l'artiste, et où chaque chose en est. Ça sert à trois choses :
savoir où on en est, écrire la home et les textes de présentation, et ne rien oublier quand on fait évoluer l'app.

**À tenir à jour** : chaque fonctionnalité ajoutée, changée ou retirée change aussi ce fichier (une ligne, dans sa
rubrique, avec son état). Les détails techniques sont dans `CLAUDE.md`.

États : **En ligne** (sur getrollout.netlify.app) · **En test** (en ligne, encore à valider sur de vrais usages) ·
**À venir** (idée retenue, pas commencée) · **En attente** (dépend de quelqu'un d'autre).

---

## En deux phrases (pour la home)

Rollout prépare tes posts TikTok de sortie : des carrousels tirés de tes photos, hooks et paroles en un clic, et des
vidéos où ta prise filmée est calée sur ton son, paroles à l'écran. Tout tourne dans ton navigateur, tes fichiers restent
dans ton Google Drive.

---

## Releases et bibliothèque

- **Une release = un projet** (un single, un EP…), avec ses carrousels, ses vidéos, ses paroles, ses audios. Dupliquer, renommer, supprimer. — En ligne
- **La Bibliothèque** : à gauche sur ordinateur, une page à part sur téléphone ; tout ce qui sert à la release (paroles, audio, vidéos, listes de textes, photos). — En ligne
- **Listes partagées ou propres à une release** : une liste de hooks peut servir à toutes les releases ou à une seule. — En ligne

## Studio carrousel

- **Générer en un clic** : chaque slide tire un texte dans sa liste (hook pour la slide 1, paroles, fin…) et une photo dans sa liste, sans jamais retomber deux fois de suite sur le même. — En ligne
- **Plusieurs carrousels par release**, téléchargés un par un ou tous d'un coup. — En ligne
- **Verrouiller une slide** pour la garder quand on régénère. — En ligne
- **Cadrer la photo** : glisser, zoomer (molette, pincer à deux doigts), avec aimantation sur les repères (Maj pour l'enlever). — En ligne
- **Bandes noires** au format voulu (2.39, 1.85…), par slide, la photo se déplace entre elles. — En ligne
- **Zones TikTok** affichées (là où l'interface cache le bas et la droite). — En ligne
- **Retouche photo** (lumière, contraste, couleurs…). — En ligne
- **IA photo** : « Plus net » (agrandit ×4 en recréant les détails) et « Remplir le cadre » (invente le bord manquant d'une photo trop petite). Dans le navigateur, rien n'est envoyé. — En test
- **Trouver des photos** sur le web depuis l'app. — En ligne
- **Appliquer à toutes les slides** un style, un cadrage, des bandes. — En ligne

## Textes : hooks, listes, tags, légendes

- **Listes par rôle** : hooks (slide 1 et vidéos), textes (les autres slides), légendes de post. Import d'un .txt. — En ligne
- **Importer ses hooks depuis des captures TikTok** (lecture du texte des captures, dans le navigateur). — En ligne
- **Importer ses hooks depuis son compte TikTok**, avec les vues de chaque post (meilleurs hooks en premier). — En attente (validation TikTok)
- **Tags automatiques**, plusieurs par hook, dans 15 catégories : annonce, sortie, émotion, histoire du son, coulisses, une phrase du son, ça sonne comme, POV, humour, hype, écoute jusqu'au bout, pépite / artiste indé, objectif / soutien, question, pour qui / quand l'écouter. — En ligne
- **Modèle d'IA local pour les tags** (comprend le sens, pas seulement les mots) ; il apprend des tags posés à la main, tags perso compris, et trie seul les hooks ajoutés ensuite. — En ligne
- **Tirer dans des tags** (« seulement les teasers ») ou **en exclure** (« jamais les hooks de sortie »), par slide et par hook vidéo. — En ligne
- **Un bouton par source**, le même en carrousel et en vidéo : la liste, et dessous ce qu'on en tire en court (« Annonce », « Tous · 1 exclu ») ; son menu : la liste, ses tags, puis les textes (ou les photos) pour en choisir un, ouvert sur celui de la slide ou du hook. — En ligne
- **Ordre alphabétique** des hooks et des tags partout ; le choix d'un hook s'ouvre sur celui déjà choisi. — En ligne
- **Textes retouchés gardés** : après un export, l'app propose d'ajouter à sa liste un hook modifié à la main. — En ligne
- **Légende et hashtags du post**, tirés d'une liste de légendes ; exportés avec le post (`caption.txt`). — En ligne

## Paroles

- **Un seul texte de paroles par release**, découpé en sections (couplet, refrain…), partagé par le carrousel et la vidéo. — En ligne
- **Slides en paroles** : une slide affiche une section, et suit les changements du texte. — En ligne
- **Paroles calées mot à mot sur l'audio** par une IA qui tourne dans le navigateur (Whisper) ; retouche à la main, gardée quand on recale. — En ligne
- **Par phrase ou mot par mot** à l'écran, longueur des lignes réglable. — En ligne

## Studio vidéo

- **Plusieurs vidéos par release**, chacune avec son fichier caméra ; « + » en crée une avec les mêmes réglages, « Dupliquer » réutilise le même fichier. — En ligne
- **Synchro automatique** de la prise sur l'audio officiel, même filmée avec le son du téléphone, une voix seule au casque, ou le passage filmé plusieurs fois (chaque prise est retrouvée). — En ligne
- **Fichiers caméra pro** : log (S-Log3, Apple Log…), HDR, 10 bits, ProRes, objectif anamorphique. — En ligne
- **Copie de travail sur le Drive** : la vidéo s'ouvre sur un autre appareil sans le fichier caméra ; l'appareil qui a l'original exporte depuis l'original. — En ligne
- **Choisir le passage (segment)** sur la forme d'onde : zoom (pincer, Ctrl + molette, boutons) gardé en mémoire ; se déplacer zoomé sans bouger le segment (deux doigts, Alt + glisser, Maj + molette). — En ligne
- **Versions A / B d'un post** (segment, textes, styles, cadrage, étalonnage) pour comparer. — En ligne
- **Hooks par-dessus la vidéo** : plusieurs, chacun avec son moment, tirés de leurs listes et tags. — En ligne
- **Paroles incrustées** sur la vidéo. — En ligne
- **Cadrage** 9:16 ou 16:9, zoom, **zoom progressif** (réglable, ou à l'intérieur de l'image seulement). — En ligne
- **Étalonnage** : log vers une image normale, LUT au choix, export 10 bits. — En ligne
- **Bandes noires** au format voulu. — En ligne
- **Presets de style** des textes, à garder et réappliquer. — En ligne
- **Plein écran**, zones TikTok, lecture qui revient au départ à la pause (réglable). — En ligne

## Audio de la release

- **L'audio officiel** de la release, partagé par toutes ses vidéos, gardé sur le Drive. — En ligne
- **Versions de l'audio** (démo, master, sped up, acoustique…) gardées côte à côte ; chaque vidéo choisit la sienne. — En test
- **Recalage automatique** quand une vidéo change de version : l'app retrouve la même musique dans l'autre version (intro rallongée, passage coupé ou ajouté, refrain répété) et recale le segment, la synchro, les prises et les paroles ; un compte rendu dit ce qui est à vérifier. On peut poster sur une démo et passer au master plus tard. — En test

## Export et partage

- **Carrousel** : les images en fichiers directs ; tous les carrousels d'un coup dans un zip (un dossier par carrousel). — En ligne
- **Vidéo** : MP4 avec sa légende ; **toutes les vidéos d'une release** à la suite. — En ligne
- **Envoyer sur mon téléphone** par QR code (pont temporaire, puis lien direct ou Drive pour les gros fichiers). — En ligne
- **Progression dans le bouton** pendant l'export. — En ligne

## Intelligence artificielle, toujours sur l'appareil

- **Paroles calées** (Whisper), **tags des hooks** (petit modèle multilingue), **IA photo** (agrandir, remplir) : téléchargés une fois, puis gardés par le navigateur ; rien n'est envoyé à un serveur. — En ligne (IA photo : En test)

## Fichiers, Drive et vie privée

- **Connexion Google**, accès Drive limité aux fichiers créés par l'app (`drive.file`). — En ligne
- **Un dossier Rollout rangé** dans le Drive : Photos / <liste>, Releases / <release> / Audios, Videos, Utils / LUTS, Fonts ; doublons fusionnés automatiquement. — En ligne
- **Tes vidéos ne passent jamais par nos serveurs** : elles restent sur l'appareil et dans ton Drive. — En ligne
- **Plusieurs appareils** : les données se mettent à jour d'un appareil à l'autre, les modifications faites en même temps sont fusionnées. — En ligne

## Téléphone

- **Une vraie app** : installable sur l'écran d'accueil, page hors ligne. — En ligne
- **Dock** studio / Créer / Style / Bibliothèque, mini-lecteur vidéo dans le dock, fenêtres en feuilles. — En ligne
- **Carrousel en pile à glisser**, photo à deux doigts, texte par appui long. — En ligne
- **Page Style** avec l'aperçu fixé en haut, réglages partie par partie. — En ligne
- **Bibliothèque complète** de la release sur une page, vidéos en bande à faire défiler. — En ligne

## Confort

- **Annuler / rétablir** sur tout. — En ligne
- **Menus clic droit maison**, rangés par catégorie (slide, aperçu vidéo, texte, photo, app). — En ligne
- **Raccourcis** : Espace (lecture), I / O (début / fin du segment), F (plein écran), G (zones TikTok). — En ligne
- **Français / anglais**. — En ligne
- **Mode démo** : un compte vierge pour essayer le studio, rien n'est enregistré. — En ligne

## Le site

- **Page d'accueil** avec un vrai carrousel à générer et une vidéo de démo, sans compte. — En ligne
- **Pages Confidentialité et Conditions**. — En ligne
- **Vérification Google** de l'app (sinon reconnexion tous les 7 jours). — En attente (Google)

## À venir (idées retenues)

- **Version live sans audio officiel** : le son de la prise comme référence. — À venir
- **Correction mot par mot sur la timeline**. — À venir
- **Aperçu vidéo plus compact** sur téléphone (option). — À venir
- **Bouton d'action flottant** (Générer / Exporter) sur téléphone. — À venir
