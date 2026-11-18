# RAW by aurare : ce que fait l'app

La liste de tout ce que RAW propose, du point de vue de l'artiste, et où chaque chose en est. Ça sert à trois choses :
savoir où on en est, écrire la home et les textes de présentation, et ne rien oublier quand on fait évoluer l'app.

**À tenir à jour** : chaque fonctionnalité ajoutée, changée ou retirée change aussi ce fichier (une ligne, dans sa
rubrique, avec son état). Les détails techniques sont dans `CLAUDE.md`.

États : **En ligne** (sur getrollout.netlify.app) · **En test** (en ligne, encore à valider sur de vrais usages) ·
**À venir** (idée retenue, pas commencée) · **En attente** (dépend de quelqu'un d'autre).

---

## En deux phrases (pour la home)

RAW prépare tes posts TikTok de sortie : des carrousels tirés de tes photos, hooks et paroles en un clic, et des
vidéos où ta prise filmée est calée sur ton son, paroles à l'écran. Tout tourne dans ton navigateur, tes fichiers restent
dans ton Google Drive.

---

## Releases et bibliothèque

- **Une release = un projet** (un single, un EP…), avec ses carrousels, ses vidéos, ses paroles, ses audios. Dupliquer, renommer, supprimer. — En ligne
- **La Bibliothèque** : à gauche sur ordinateur, une page à part sur téléphone ; tout ce qui sert à la release (paroles, audio, vidéos, listes de textes, photos). — En ligne
- **Listes partagées ou propres à une release** : une liste de hooks peut servir à toutes les releases ou à une seule. — En ligne
- **Pas deux fois la même photo dans une liste** : l'app reconnaît une photo à son image (même enregistrée deux fois en fichiers différents, par exemple reconvertie par le téléphone) ; elle n'est pas ajoutée une seconde fois, et les doublons déjà là se retirent en un clic. — En ligne

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
- **Un bouton par source**, le même en carrousel et en vidéo, sur une ligne : la liste, puis ses tags en court et le début de ce qui est choisi (« Hooks · 1 exclu · Benson Boone + … », « Paroles · Pont · Refrain 3 », « Slide 1 · TIKTOK_PIC_12 ») ; son menu : la liste, ses tags, puis les textes (ou les photos) pour en choisir un, ouvert sur celui de la slide ou du hook. Le hook vidéo se présente comme une slide : son titre, son texte, sa source et Générer, puis son minutage. — En ligne
- **Ordre alphabétique** des hooks et des tags partout ; le choix d'un hook s'ouvre sur celui déjà choisi. — En ligne
- **Textes retouchés gardés** : après un export, l'app propose d'ajouter à sa liste un hook modifié à la main. — En ligne
- **Légende et hashtags du post**, tirés d'une liste de légendes ; exportés avec le post (`caption.txt`). — En ligne

## Paroles

- **Déplacer une coupure entre deux lignes de paroles** : « Joindre à la suivante » dans l'éditeur d'une ligne (texte et timing gardés), puis « Couper ici » où il faut. — En test
- **Glisser le début ou la fin d'une ligne de paroles ou d'un hook** sur sa piste, comme un cut multicam (la fin là où il y a un vide après) : sans vide (la ligne d'avant reste jusqu'à elle), Alt pour n'en bouger qu'une (un vide possible) ; le + d'une ligne collée à la suivante la fait enfin commencer plus tard. — En test
- **Modèle « Très précis »** (Whisper large-v3-turbo, environ 560 Mo téléchargés une fois, carte graphique) par défaut quand l'ordinateur en a une : il entend le chant sur une prod chargée ; chaque phrase s'affiche à l'attaque de la voix, jamais pendant le vide qui la précède. — En test
- **Calage des paroles par alignement forcé** : tes paroles étant connues, l'app ne les devine plus dans le son, elle les place mot par mot au rythme où elles sont chantées (modèle MMS d'alignement, environ 1,3 Go téléchargés une fois pour la carte graphique, 630 Mo sur processeur, plus lent) ; plus précis qu'une reconnaissance vocale sur un refrain répété ou un mix chargé. Si le modèle ne peut pas tourner, l'ancienne écoute vocale prend le relais. Un passage qu'il n'entend presque pas (hook ou refrain plein d'effets) est réécouté par phrases ; un refrain copié-collé (mêmes lignes répétées) est calé en écoutant ses copies ensemble, toutes placées pareil. Les lignes dont le placement est douteux (tassées sur la suivante, mots éparpillés) portent un point jaune « à vérifier » dans la liste des paroles, qui disparaît quand tu les retouches. — En test
- **Moteur des paroles plus rapide et plus fiable** : l'écoute tourne sur la carte graphique quand elle est disponible (une chanson de 2 min en ~40 s), le son est préparé pour la voix, les répétitions inventées par le modèle sont retirées ; si le calage est trop faible, nouvelle écoute avec le modèle précis, puis paroles posées à peu près sur le chant à vérifier (plus d'échec sec). — En test

- **Les lignes de paroles s'affichent comme tu les écris** : une ligne écrite = un sous-titre, même avec une pause ou une note tenue dedans ; coupée seulement si elle est vraiment trop longue (à une virgule d'abord) ou s'il y a un vrai blanc de 2 s au milieu. — En test
- **Un seul texte de paroles par release**, découpé en sections (couplet, refrain…), partagé par le carrousel et la vidéo. — En ligne
- **Slides en paroles** : une slide affiche une section, et suit les changements du texte. — En ligne
- **Paroles calées mot à mot sur l'audio** par une IA qui tourne dans le navigateur (Whisper) ; retouche à la main, gardée quand on recale. — En ligne
- **Piste vidéo** (une seule caméra, sans multicam) : la vidéo apparaît comme un clip sous les paroles ; non verrouillée sur l'audio, on la glisse le long de la piste et on rogne ses bords, comme un montage classique sans synchro (noir là où il n'y a pas d'image) ; « Vidéo entière » annule le rognage ; le haut-parleur au bout de la piste ouvre « Son de la vidéo » (0 à 100 %, coupé par défaut) garde le son de la prise, mêlé au son officiel à l'aperçu et à l'export, seulement sur le passage gardé ; verrouillée (synchronisée), elle est affichée sans bouger. Gardé dans la version. — En test
- **Boucle et cadenas séparés** : le cadenas verrouille ou libère la synchro de toutes les vidéos d'un coup ; la boucle (à côté) fait rejouer le segment en boucle, ou, désactivée, laisse la lecture continuer au-delà du segment et la tête aller partout dans le morceau. — En test
- **Remplacer l'audio depuis cet ordinateur** (menu ⋯ de la carte Audio) : un nouveau fichier pour la version ouverte (un nouveau master, une version plus longue) ; si c'est le même morceau, les paroles et les vidéos suivent la musique dedans, sinon elles repartent de zéro. — En test
- **Masquer une vidéo** (œil au bout de sa piste) : la vidéo n'est plus dessinée, à l'aperçu comme à l'export ; son son et sa place restent ; la vidéo du bas masquée (ou tout son multicam) laisse du noir sous les autres. — En test
- **Caler les paroles au clavier** (comme Musixmatch) : pendant la lecture, ↓ fait commencer la phrase suivante à l'instant pile, ↑ fait recommencer la phrase en cours (si ↓ était trop tôt) ; la phrase d'avant garde sa fin (raccourcie seulement si elle chevauche, jamais étirée). Les lignes que le modèle a mal entendues sont marquées d'un point jaune « à vérifier ». — En test
- **Remplacer le fichier d'une prise** (menu ⋯ de sa ligne) : un autre fichier à sa place (un montage avec le morceau dessous…), synchronisé aussitôt ; rien de l'ancien fichier ne reste. — En test
- **Vidéo par-dessus verrouillée une fois synchronisée** (cadenas sur le clip pour la libérer) : elle ne glisse plus de côté, mais change toujours de ligne. — En test
- **Aimants** : un clip (paroles, hook, vidéo) glissé près du début du segment ou de la tête de lecture s'y colle ; ⌘ pour le placer librement ; glisser un clip ne déplace plus la tête. — En test
- **Verrouiller une ligne de paroles** (cadenas sur son clip, ou toutes d'un coup avec le cadenas au bout de la piste : fermé = toutes, point jaune = certaines) : elle reste telle quelle quand on recale les paroles ; « Recaler les paroles » demande d'abord confirmation s'il y a des retouches (tout recaler, ou seulement les lignes non verrouillées). — En test
- **Recaler les mots dans leurs lignes** (menu Synchroniser) : chaque ligne reste à sa place, ses mots se recalent sur la voix ; aussi tout seul quand on place une ligne aux flèches. — En test
- **Les lignes s'ajoutent** (style des paroles et du hook) : autour de sa place, vers le bas (la 1re ligne reste) ou vers le haut. — En test
- **Paroles « Phrase, allumée mot à mot »** : la phrase entière à l'écran, ses mots s'allument quand ils sont chantés (d'un coup comme TikTok, ou en se remplissant comme Apple Music), les autres estompés (réglable) ; à côté de « Phrase par phrase » et « Mot à mot ». — En test
- **Paroles hors du segment** : boucle activée, grisées ; boucle coupée, toute la timeline se lit comme le segment (en couleur, allumées quand la tête passe dessus), sans entrer dans le post. — En test
- **Déplacer une ligne de paroles** : on la glisse par son corps sur la timeline, comme un clip de montage ; elle garde sa durée et reste entre ses voisines. — En test
- **Poignées des clips** : chaque texte et chaque hook a sa poignée de début et de fin, dans le clip, visible au survol (comme les vidéos), même collé au suivant ; la tête de lecture suit le bord tiré et s'arrête avec lui à la durée minimale. — En test
- **Timeline en un seul cadre** (ordinateur) : forme d'onde pleine (comme Ableton), son bandeau à la couleur de la vidéo choisie avec l'icône et « VIDÉO 1…4 », hook, paroles et vidéos dans un même bloc, chaque clip avec l'icône de son type et sa couleur (paroles en or, hook en bleu, vidéos à la couleur de la vidéo), une seule tête de lecture qui traverse tout. — En test
- **Timeline vidéo façon CapCut** : toutes les pistes vidéo dans un même bloc ; chaque clip se glisse verticalement (on porte le clip lui-même, même après un petit glisser de côté ; dès que la souris passe la moitié du clip à remplacer, les deux vidéos vont échanger leur place : l'autre remonte ou descend et celui qu'on tient s'aimante à sa place, comme dans CapCut ; chaque clip porte son numéro) (sur la ligne de l'autre vidéo : multicam ; au-dessus ou en dessous : elles échangent leur place, n'importe quelle vidéo peut devenir la base), un fantôme suit le pointeur ; chaque vidéo garde sa couleur (1 blanc, 2 violet, 3 vert, 4 or) dans la bibliothèque, ses clips et la bande de la forme d'onde, qui montre la vidéo sélectionnée ; glisser une prise du projet depuis la bibliothèque sur la ligne de base = multicam (les boutons de caméra apparaissent), au-dessus = par-dessus la vidéo (le clip suit le pointeur et se pose où on lâche) ; une vidéo synchronisée pour la première fois a son propre son coupé (c'est l'audio officiel entendu par la caméra ; on le remonte au haut-parleur, une resynchro garde ce choix) ; « Synchroniser » essaie toutes les vidéos du projet, même si la première n'a aucun son en commun avec l'audio officiel, et dit lesquelles sont calées et lesquelles restent libres (à placer à la main) ; échanger deux vidéos ne recharge plus rien (audio, forme d'onde, lecture restent) et chaque vidéo garde ses réglages (couleur, cadrage, taille et place par-dessus) où qu'elle aille ; pendant la lecture, un clip vidéo reste collé à gauche (bord coloré et nom) jusqu'à sa fin, avec la barre lumineuse et la lueur du nom comme les paroles et les hooks ; son de chaque caméra (entendu sur ses plans). — En test
- **Relier le fichier original de chaque prise** (menu ⋯ de sa ligne dans la Bibliothèque, pas seulement la vidéo 1) : le même fichier retrouvé sur l'ordinateur, synchro et réglages gardés ; un fichier qui n'est pas le sien (autre taille) n'est jamais montré à sa place. — En test
- **Plusieurs vidéos dans la timeline** : chaque prise importée arrive aussitôt sur sa propre ligne, au-dessus des autres (1, 2, 3, 4 de bas en haut, 4 vidéos au plus) ; on les glisse pour changer leur ordre, en faire la vidéo du bas ou les mettre dans le multicam (une piste multicam peut avoir d'autres vidéos par-dessus) ; menu ⋯ de chaque prise : mettre dans le multicam ou sur sa propre ligne, retirer du projet. — En test
- **Vidéo par-dessus (incrustation)** : une autre prise de la release posée par-dessus la vidéo (menu « … » de la prise → « Mettre par-dessus la vidéo », ou, comme dans CapCut, un plan de la piste multicam tiré vers le haut ; tirée vers le bas, elle redevient une caméra du multicam) ; cliquée (aperçu ou piste), la colonne de droite règle sa couleur et son cadrage dans son cadre ; sa propre piste au-dessus de la piste vidéo, où on la glisse et on rogne ses bords ; sur l'aperçu, on la déplace en la glissant et on change sa taille à la molette ; réglages au bout de sa piste : taille, coins arrondis, son, vidéo entière, retirer ; étalonnée comme sa prise ; à l'aperçu et à l'export (image et son) ; copie Drive pour les autres appareils. — En test
- **Sous-titres personnalisés** : en mot à mot ou phrase par phrase, un mot (ou une phrase) peut avoir son propre style (police, effet, taille, couleurs, place) : « Ce mot » dans le panneau Paroles, ou clic droit dessus sur la vidéo ; il se déplace seul sur l'aperçu ; « Relier au style des paroles » lui rend le style des paroles ; marqué d'un point sur la piste des paroles ; gardé dans la version de la vidéo. — En test
- **Par phrase ou mot par mot** à l'écran, longueur des lignes réglable. — En ligne

## Studio vidéo

- **Plusieurs vidéos par release**, chacune avec son fichier caméra ; « + » en crée une de zéro (le même morceau et les mêmes paroles, sans vidéo ni hook ; numérotée Vidéo 1, 2, 3… dans chaque release), « Dupliquer » refait la même vidéo (même fichier, mêmes réglages). — En ligne
- **Synchro automatique** de la prise sur l'audio officiel, même filmée avec le son du téléphone, une voix seule au casque, ou le passage filmé plusieurs fois (chaque prise est retrouvée). — En ligne
- **Fichiers caméra pro** : log (S-Log3, Apple Log…), HDR, 10 bits, ProRes, objectif anamorphique. — En ligne
- **Copie de travail sur le Drive** : la vidéo s'ouvre sur un autre appareil sans le fichier caméra ; l'appareil qui a l'original exporte depuis l'original. — En ligne
- **Choisir le passage (segment)** sur la forme d'onde : zoom sur toute la timeline, pas seulement la forme d'onde (pincer à deux doigts ou ⌘ / Ctrl + molette depuis n'importe quelle piste, molette enfoncée en glissant vers le bas / le haut comme dans Ableton, boutons) gardé en mémoire ; se déplacer zoomé sans bouger le segment (deux doigts, Alt + glisser, Maj + molette). Les pistes en dessous (paroles, hooks, plans multicam) sont à la même échelle que la forme d'onde, zoomée ou non (le segment y est marqué ; sur téléphone sans zoom, le segment), pour retoucher leurs bords et leurs coupes dans le détail. Zoomé, pendant la lecture, la timeline défile sous la tête de lecture, tenue au tiers de la vue (comme Logic), ou là où elle était au lancement si elle était plus à droite (sans saut) ; à l'arrêt la vue ne bouge pas. — En ligne
- **Versions A / B d'un post** (segment, textes, styles, cadrage, étalonnage) pour comparer. — En ligne
- **Hooks par-dessus la vidéo** : plusieurs, chacun avec son moment, tirés de leurs listes et tags. Un hook s'étire partout dans le morceau, avant ou après le segment (visible à l'aperçu hors du segment ; le post n'en garde que la partie dans le segment). — En ligne
- **Paroles incrustées** sur la vidéo. — En ligne
- **Cadrage** 9:16 ou 16:9 (commun à la vidéo), zoom (de 0,15× à 4×) ; en multicam, chaque caméra a son cadrage, sa couleur, ses bandes noires et son zoom progressif, **zoom progressif** (réglable, ou à l'intérieur de l'image seulement). — En ligne
- **Étalonnage** : log vers une image normale, export 10 bits ; sortie par le Rec.709 neutre de l'app ou par **n'importe quelle LUT**, réglée comme un CST dans DaVinci : ce qu'elle attend (log de la caméra, DaVinci Wide Gamut / Intermediate, Rec.709 / Cineon, Rec.709 / gamma 2.4, deviné à l'import), ce qu'elle sort, et la compression des hautes lumières. — En ligne
- **Roues de couleur** à la Final Cut (Global, Ombres, Tons moyens, Hautes lumières, comme les primaires de DaVinci), avant la LUT, avec un point de couleur et une réglette de luminosité chacune. — En test
- **Effets** : **Black Mist** (filtre de diffusion : la lumière des zones claires se répand autour d'elles, sans voile, avec un seuil réglable ; les ombres prennent un peu de la lumière ambiante), **Halation** (liseré rouge orangé autour des lumières fortes, comme sur pellicule, seuil réglable) et **Brume** (brouillard cinéma plus dense vers le haut et sur les zones claires, teinte froide à chaude), à l'aperçu comme à l'export, gardés dans les presets de couleur. — En test
- **Couper sans perdre** : un interrupteur coupe toute la couleur (aperçu et export), d'autres coupent les Corrections, les Roues, les Effets ou la Finition, comme un node désactivé dans DaVinci ; les réglages sont gardés. — En ligne
- **Presets de couleur** : enregistrer tout un étalonnage (profil caméra, LUT, réglages, roues) et le poser sur une autre vidéo d'un clic, puis le retoucher ; chaque preset dit s'il est fait pour du SDR, du log ou du HDR, et un preset qui ne va pas avec la vidéo (log sur une vidéo SDR…) est déconseillé avant d'être posé. — En ligne
- **Bibliothèque de LUT du compte** : une LUT importée est disponible sur tous tes appareils (sa copie va sur ton Drive) ; jamais deux fois la même ; une corbeille au survol pour en supprimer une (confirmation, les vidéos qui l'utilisent repassent en Rec.709). — En ligne
- **Réglages d'une LUT par vidéo** : ce que la LUT attend (log de la caméra, Cineon…), ce qu'elle sort et la compression des hautes lumières sont ceux de chaque vidéo (une prise peut demander Cineon, une autre le log de la caméra) ; les LUT d'Alister Chapman sont reconnues à l'import (log de la caméra). — En test
- **Bandes noires** au format voulu. — En ligne
- **Presets de style** des textes, à garder et réappliquer. — En ligne
- **Vidéos rangées** dans le sélecteur : Log, HDR, Standard (SDR), autres, aussi dans le choix des caméras du multicam. — En ligne
- **Plein écran** (sur ordinateur, il couvre le board du milieu seulement : header et colonnes restent visibles et utilisables, pour retoucher la couleur en regardant l'image en grand), zones TikTok, lecture qui revient au départ à la pause (réglable). — En ligne
- **Prises et projets** : les fichiers caméra / téléphone s'importent dans la release (un ou plusieurs d'un coup, « Importer des prises »), chacun se synchronise seul sur l'audio officiel en arrière-plan, sans créer de projet ; un projet (un post) prend jusqu'à 4 prises ; « Autres prises de la release » repliée sous celles du projet. Un fichier déjà importé (même nom, même taille) n'est pas recréé. La prise du projet (caméra 1) toujours en carte complète, les autres en lignes numérotées dépliables en carte (durée, type, copie Drive « Sauvegardée », synchro), dans la couleur de sa caméra, avec une transition de hauteur ; chaque prise a sa copie Drive pour les autres appareils (toute la partie de la vidéo posée sur le morceau, dans son rognage : on voit tout, même hors du segment) ; un clic sur une prise montre ses détails ; un doublon déjà importé est fusionné. — En test
- **Montage multicam** : avec plusieurs prises dans un projet, boutons 1 à 4 et « Couper » au-dessus de la piste des plans (téléphone compris) ; les boutons ou touches 1 à 4 coupent vers une caméra à la tête de lecture (en lecture comme à l'arrêt), au début d'un plan ils changent tout le plan ; une croix au survol d'un plan (sur téléphone : le plan sélectionné) retire son cut, double-clic sur un trait aussi ; un trait glissé s'aimante au début ou à la fin des lignes de paroles et des hooks (⌘ : sans aimant) ; les cuts se glissent sur la piste des plans ; chaque caméra garde sa synchro, son cadrage et son étalonnage, réglés dans la colonne de droite quand elle est affichée (clic sur la prise ou sur un de ses plans ; « Réglages de N » en tête ; « Autres caméras » copie la couleur sur celles du même type) ; lié à la vidéo, le segment reste dans la partie filmée par toutes les caméras ; l'export suit les cuts. — En test

## Audio de la release

- **L'audio officiel** de la release, partagé par toutes ses vidéos, gardé sur le Drive. — En ligne
- **Versions de l'audio** (démo, master, sped up, acoustique…) gardées côte à côte ; chaque vidéo choisit la sienne. — En test
- **Recalage automatique** quand une vidéo change de version : l'app retrouve la même musique dans l'autre version (intro rallongée, passage coupé ou ajouté, refrain répété) et recale le segment, la synchro, les prises et les paroles ; un compte rendu dit ce qui est à vérifier. On peut poster sur une démo et passer au master plus tard. — En test

## Export et partage

- **Carrousel** : les images en fichiers directs ; tous les carrousels d'un coup dans un zip (un dossier par carrousel). — En ligne
- **Vidéo** : MP4 avec sa légende ; **toutes les vidéos d'une release** à la suite. — En ligne
- **Export calé sur la prise, réglé pour TikTok et Instagram** : 1080 × 1920, H.264, à la cadence filmée (25p reste 25p, 50/60p restent fluides, aucune image doublée), 16 Mb/s (jusqu'à 24 en 50/60p, sous le plafond d'Instagram), son AAC 256 kb/s en 48 kHz au plus, une image clé toutes les 2 s. — En ligne
- **Rubrique Export** (colonne de droite du studio vidéo, onglet Export sur téléphone) : les réglages recommandés affichés (format, cadence, image, son) ; « Modifier » permet de choisir sa cadence, sa qualité d'image et de son, pour toutes ses vidéos, avec retour aux réglages recommandés. — En ligne
- **Envoyer sur mon téléphone** par QR code (pont temporaire, puis lien direct ou Drive pour les gros fichiers). — En ligne
- **Progression dans le bouton** pendant l'export. — En ligne

## Intelligence artificielle, toujours sur l'appareil

- **Paroles calées** (Whisper), **tags des hooks** (petit modèle multilingue), **IA photo** (agrandir, remplir) : téléchargés une fois, puis gardés par le navigateur ; rien n'est envoyé à un serveur. — En ligne (IA photo : En test)

## Fichiers, Drive et vie privée

- **Connexion Google**, accès Drive limité aux fichiers créés par l'app (`drive.file`). — En ligne
- **Un dossier RAW rangé** dans le Drive : Photos / <liste>, Releases / <release> / Audios, Videos, Utils / LUTS, Fonts ; doublons fusionnés automatiquement. — En ligne
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

- **Brume avec profondeur** (IA) : le brouillard placé selon la distance, comme le Cinematic Haze de DaVinci. — À venir
- **Typo animée** : un mot mis en avant (autre police, taille, apparition). — À venir
- **Cuts calés sur les paroles** en multicam. — À venir
- **Version live sans audio officiel** : le son de la prise comme référence. — À venir
- **Correction mot par mot sur la timeline**. — À venir
- **Aperçu vidéo plus compact** sur téléphone (option). — À venir
- **Bouton d'action flottant** (Générer / Exporter) sur téléphone. — À venir
