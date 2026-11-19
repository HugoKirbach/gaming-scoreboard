# Gaming scoreboard

Un petit site qui classe la bande selon le temps passé sur un jeu PS5 (actuellement **GTA VI**) et sur tous les jeux PS4/PS5 : cumul, 7 derniers jours, dernières 24 h, une courbe « La course » et les trophées de chacun.

- Les temps de jeu viennent du **PSN**, lus toutes les heures par GitHub Actions, ou à la demande avec le bouton **Actualiser**.
- Le site est hébergé gratuitement sur **GitHub Pages** : <https://hugokirbach.github.io/gaming-scoreboard/>
- Rockstar ne fournit plus de stats publiques depuis la fermeture du Social Club, d'où le passage par le PSN.

## Mise en place

### 1. Lister les joueurs

Modifie `config.json` : un bloc par personne, avec son **pseudo PSN exact** (`psn`) et le nom affiché (`name`). Les pseudos d'exemple (`TON_PSEUDO_PSN`, `PSEUDO_AMI_1`…) sont ignorés.

```json
"players": [
  { "psn": "TonPseudoPSN", "name": "Hugo" },
  { "psn": "PseudoDeMehdi", "name": "Mehdi" }
]
```

L'ordre de la liste fixe la couleur de chacun dans le graphique (8 couleurs maximum ; au-delà, les joueurs restent dans le classement mais pas dans la courbe).

### 2. Donner l'accès au PSN (jeton NPSSO)

1. Connecte-toi sur [playstation.com](https://www.playstation.com/) avec ton compte PSN.
2. Dans le même navigateur, ouvre <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copie la valeur de `npsso` (64 caractères).
4. Sur GitHub : *Settings › Secrets and variables › Actions › New repository secret*.
   Nom : `PSN_NPSSO`, valeur : le jeton copié.

> ⚠️ Ce jeton équivaut à une session connectée sur ton compte PSN. Ne le colle **jamais** dans un fichier du dépôt, seulement dans les secrets.

### 3. Activer le site

1. *Settings › Pages › Build and deployment › Source* : choisis **GitHub Actions**.
2. Onglet *Actions* › **Mise à jour du classement** › **Run workflow**.
3. Le site est en ligne sur <https://hugokirbach.github.io/gaming-scoreboard/>. Tant que les pseudos ou le jeton manquent, il s'affiche en mode démo avec un bandeau qui dit ce qui manque.

### 4. Chaque ami doit rendre son historique visible

Sur PS5 : *Paramètres › Utilisateurs et comptes › Confidentialité*, puis dans la rubrique *Jeux | Médias*, régler qui peut voir l'historique de jeu sur **Tout le monde**. (« Amis » devrait aussi fonctionner si tu es dans leur liste d'amis PSN.)

Les trophées ont leur propre réglage dans la même rubrique (qui peut voir les trophées). S'il est privé, le temps de jeu s'affiche quand même, avec « trophées masqués ».

Les profils encore verrouillés apparaissent en bas du site avec la marche à suivre.

## Changer de jeu

Le jeu suivi se règle en haut de `config.json`. Réglage actuel pour GTA VI :

```json
"title": "Classement GTA VI",
"kicker": "Leonida · PS5 · entre potes",
"subtitle": "Qui passe le plus de temps à Vice City ?",
"game": {
  "label": "GTA VI",
  "match": "grand\\s*theft\\s*auto\\s*(vi|6)\\b|\\bgta\\s*(vi|6)\\b",
  "releaseDate": "2026-11-19"
},
```

Avec `releaseDate`, la page affiche un compte à rebours tant que personne n'a lancé le jeu (mets `null` pour un jeu déjà sorti). Pour un autre jeu, change `label`, `match` (une partie du nom du jeu sur le PSN, par exemple `"\\broblox\\b"`) et les textes. Quand le jeu change, sa courbe repart de zéro ; l'historique « tous les jeux » est conservé.

## Bouton « Actualiser » et mise à jour horaire fiable

Un petit relais gratuit chez Cloudflare (`cloudflare/worker.js`) lance la mise à jour quand quelqu'un clique sur **Actualiser** (au plus une fois toutes les 5 minutes). Ton jeton GitHub reste secret chez Cloudflare, jamais dans la page.

1. **Jeton GitHub** : <https://github.com/settings/personal-access-tokens/new>
   - *Repository access* : *Only select repositories* › `gaming-scoreboard`
   - *Permissions* › *Actions* : **Read and write**
   - Génère-le et copie-le.
2. **Relais Cloudflare** (compte gratuit sur <https://dash.cloudflare.com>) :
   - *Workers & Pages* › *Create* › *Hello World*, nomme-le par exemple `classement-relais`, puis *Deploy*.
   - *Edit code* : remplace tout par le contenu de `cloudflare/worker.js`, puis *Deploy*.
   - *Settings* › *Variables and Secrets* › *Add* : type **Secret**, nom `GITHUB_TOKEN`, valeur : le jeton de l'étape 1.
   - Facultatif : *Settings* › *Triggers* › *Cron Triggers* › *Add* `17 * * * *` pour un second déclencheur horaire, en plus de la minuterie GitHub.
3. **Brancher le bouton** : copie l'adresse du relais (`https://classement-relais.<ton-compte>.workers.dev`) dans `config.json`, champ `refreshUrl`. Le bouton apparaît sur le site à la mise à jour suivante.

Le bouton ne fait pas aller Sony plus vite : si le PSN n'a pas encore enregistré une session, elle n'apparaîtra qu'au moment où Sony la publie.

## Mise à jour horaire

La programmation « schedule » de GitHub saute souvent des créneaux. Chaque mise à jour lance donc à la fin une **minuterie** (`.github/workflows/minuterie.yml`) qui attend environ une heure puis relance la mise à jour suivante. Une seule minuterie tourne à la fois. Si la chaîne s'arrête (panne GitHub, exécution annulée à la main), elle repart à la prochaine modification du dépôt, au prochain créneau programmé que GitHub n'aura pas sauté, ou avec *Actions › Mise à jour du classement › Run workflow*.

## Entretien

- **Tous les ~2 mois**, le jeton NPSSO expire : le workflow échoue et GitHub t'envoie un mail. Refais l'étape 2 et remplace le secret.
- Pour ajouter quelqu'un, modifie `config.json` : la mise à jour se relance toute seule.
- Pour voir le site avec des données fictives : ajoute `?demo` à l'adresse.

## Bon à savoir

- Le temps de jeu est celui que Sony enregistre (celui de la fiche du jeu sur PS5). Il arrive qu'il se mette à jour avec un peu de retard, souvent à la fin d'une session.
- L'accès passe par [psn-api](https://psn-api.achievements.app), une librairie **non officielle**. Sony peut la casser du jour au lendemain. Le script reste volontairement léger (une lecture par joueur toutes les heures) pour ne pas solliciter le PSN.
- Le jeu est reconnu par son nom (`game.match` dans `config.json`, une expression régulière insensible à la casse).
- Le site est public : tout le monde avec le lien voit les pseudos et les heures. Préviens la bande.

## Lancer à la main (facultatif)

Avec Node.js 20 ou plus, dans le dossier du projet (PowerShell sous Windows) :

```powershell
npm install
$env:PSN_NPSSO = "ton_jeton"
node scripts/update.mjs   # écrit docs/data.json et docs/history.json
```
