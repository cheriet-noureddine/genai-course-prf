# IA Générative pour Enseignants — version backend/API

Le cours était un unique fichier HTML de ~370 Ko contenant tout : les 29 leçons,
les 7 quiz de module, les bonnes réponses, le mot de passe du cours, etc.,
directement lisibles dans le code source par n'importe quel visiteur.

Ce dossier restructure le projet en deux parties :

```
project/
├── server/              ← backend Node.js / Express
│   ├── server.js         API + fichiers statiques
│   ├── package.json
│   └── data/
│       ├── course-meta.json        table des matières (titres, pas de contenu)
│       ├── lessons/<mi>-<li>.json  contenu de chaque leçon, un fichier chacune
│       ├── lesson-quizzes.json     questions + BONNES RÉPONSES (serveur only)
│       ├── module-quizzes/<mi>.json  idem, par module
│       ├── diagrams/<key>.json     fragments HTML des graphiques
│       └── auth.json               hash + sel du mot de passe (pas le mot de passe en clair)
└── public/               ← frontend statique
    ├── index.html         coquille vide (login + zone de contenu)
    ├── app.js              appelle l'API, n'a jamais le cours en mémoire
    └── style.css           feuille de style d'origine, inchangée
```

## Ce qui a changé concrètement

- **Plus aucun contenu de cours dans le HTML.** `index.html` ne contient que
  la mise en page ; les leçons, quiz et bonnes réponses ont été extraits
  automatiquement du fichier original vers `server/data/`.
- **Une leçon = un appel API = un fichier.** `GET /api/lesson/:mi/:li` ne
  renvoie que la leçon demandée. Le navigateur ne télécharge jamais les 28
  autres.
- **Les bonnes réponses ne quittent jamais le serveur avant validation.**
  `GET /api/lesson/:mi/:li/quiz` renvoie la question et les choix, sans le
  champ `correct` ni `explain`. C'est seulement `POST .../quiz/submit` (avec
  la réponse choisie) qui déclenche la correction côté serveur et renvoie le
  résultat. Même logique pour les quiz de module.
- **Le mot de passe du cours n'est plus dans le JavaScript client.** Il est
  stocké côté serveur sous forme de hash salé (`scrypt`), vérifié dans
  `POST /api/auth/login`, comparé avec `crypto.timingSafeEqual`. La session
  est un cookie `httpOnly` opaque (un token aléatoire), pas le mot de passe.
- **Toutes les routes de contenu exigent une session valide**
  (`requireAuth`), donc même en devinant les URLs on ne peut rien récupérer
  sans s'être authentifié.

## Ce qui n'a volontairement pas changé

- Le rendu visuel : la feuille de style d'origine est reprise telle quelle.
- Les diagrammes (Chart.js) : leur contenu n'est pas secret, ils sont
  simplement chargés à la demande (`GET /api/diagram/:key`) plutôt
  qu'embarqués partout — cela évite aussi de charger 9 configurations de
  graphique pour une seule leçon qui en affiche un.
- La progression de l'élève reste dans `localStorage` du navigateur : ce
  n'est pas une donnée sensible, donc pas indispensable de la faire
  transiter par le serveur. Voir "Pour aller plus loin" ci-dessous si vous
  voulez quand même la centraliser.

## Lancer le projet

```bash
cd server
npm install
npm start          # http://localhost:3000
```

Le serveur Express sert aussi les fichiers du dossier `public/`, donc un
seul processus suffit en développement comme en petite production.

Mot de passe de test (identique à l'original) : `selouani-school`

## Résumé de l'API

| Méthode | Route | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/login` | non | `{password}` → cookie de session |
| POST | `/api/auth/logout` | non | invalide la session |
| GET | `/api/auth/me` | non | vérifie si une session est active |
| GET | `/api/toc` | oui | titres des modules/leçons, sans contenu |
| GET | `/api/lesson/:mi/:li` | oui | contenu de **cette** leçon uniquement |
| GET | `/api/lesson/:mi/:li/quiz` | oui | question + choix, **sans** la réponse |
| POST | `/api/lesson/:mi/:li/quiz/submit` | oui | `{selected}` → correction |
| GET | `/api/module/:mi/quiz` | oui | questions du quiz de module, sans réponses |
| POST | `/api/module/:mi/quiz/submit` | oui | `{answers:[...]}` → score + corrections |
| GET | `/api/diagram/:key` | oui | fragment HTML d'un graphique |
| GET | `/api/final-project` | oui | consignes du projet final |

## Pour aller plus loin (non fait ici, par souci de portée)

- Remplacer les fichiers JSON par une vraie base (Postgres/SQLite/Mongo) :
  seuls les petits helpers `readJSON`/`readLesson` de `server.js` auraient
  à changer, les routes resteraient identiques.
- Remplacer la session en mémoire (`Map`) par Redis ou un store en base,
  pour survivre à un redémarrage ou fonctionner avec plusieurs instances.
- Déplacer la progression (`localStorage`) vers `POST/GET /api/progress`,
  rattachée à la session, si vous voulez un suivi consultable côté
  formateur.
- Ajouter HTTPS / un reverse proxy (nginx, Caddy) devant Express en
  production, et mettre `secure: true` sur le cookie de session.
