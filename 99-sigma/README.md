# 99 sigma

Le jeu de cartes du 99 en ligne, avec le bus pour le perdant. De 2 à 6 joueurs,
sans compte : on partage un lien et on joue.

## Mettre le site en ligne (gratuit, une dizaine de minutes)

### 1. Déposer les fichiers sur GitHub
1. Crée un compte sur https://github.com si tu n'en as pas.
2. En haut à droite, clique sur **+** puis **New repository**.
   Nomme-le `99-sigma`, laisse-le en **Public**, puis **Create repository**.
3. Sur la page du dépôt vide, clique sur **uploading an existing file**.
4. Glisse **le contenu** du dossier dézippé : `server.js`, `package.json`,
   `render.yaml`, `README.md`, `test.js` et le dossier `public`
   (il contient `index.html`). Clique sur **Commit changes**.

Vérifie que `public/index.html` apparaît bien dans le dépôt : si le dossier
`public` manque, le site ne s'affichera pas.

### 2. Héberger sur Render
1. Crée un compte sur https://render.com avec ton compte GitHub.
2. Clique sur **New +** puis **Web Service**, et choisis le dépôt `99-sigma`.
3. Vérifie les réglages (normalement déjà remplis) :
   - Runtime : **Node**
   - Build Command : `echo pas de dependance`
   - Start Command : `node server.js`
   - Instance Type : **Free**
4. Clique sur **Deploy Web Service**. Après une à deux minutes, Render affiche
   une adresse du type `https://99-sigma-xxxx.onrender.com`.

### 3. Jouer
Ouvre l'adresse, choisis un pseudo et clique sur **Créer une table**.
Envoie le lien de la salle d'attente à tes amis, puis **Lancer la partie**.

## À savoir
- Offre gratuite de Render : le site s'endort après 15 minutes sans visite.
  La première ouverture prend alors environ une minute. Ouvre-le un peu avant
  la soirée.
- Les tables vivent en mémoire : si le serveur redémarre ou s'endort, les
  tables en cours disparaissent et il suffit d'en créer une nouvelle.
- Un ami qui recharge la page ou perd un instant le réseau retrouve sa place
  automatiquement. S'il ferme l'onglet, il rouvre le lien
  avec le même pseudo et récupère sa place et ses cartes.
- Quelqu'un qui arrive en pleine partie joue à la suivante. Au-delà de
  6 joueurs, les suivants regardent.

## Essayer sur ton ordinateur
Avec Node 18 ou plus installé (https://nodejs.org) :

    node server.js

Puis ouvre http://localhost:3000 dans deux onglets (ou deux navigateurs)
pour jouer contre toi-même. `node test.js` lance le test automatique.

## Règles intégrées
- 52 cartes, 4 cartes chacun, on repioche après chaque carte posée.
- Le total part de 0. As à 10 : on ajoute leur valeur (As = 1).
- Valet : −10 (sans descendre sous 0). Dame : total inchangé, le sens s'inverse.
- Roi : on fixe le total à la valeur de son choix, entre 1 et 98.
- Celui qui fait atteindre 99 ou plus perd.
- Pioche vide : on continue avec ses cartes. Si personne n'atteint 99,
  le dernier à garder une carte perd.
- Le perdant commence la partie suivante.
- Bus : le perdant annonce plus, moins ou même valeur pour la carte suivante
  (As = 1, Roi = 13). 7 bonnes réponses d'affilée pour sortir. Une erreur
  remet le compteur à zéro et on repart de la dernière carte retournée.
