# env-fleet

Gestionnaire graphique des fichiers `.env` d'une flotte de serveurs en SSH.
Arbre **Projet → Type (PRODUCTION / DEVELOPMENT…) → Serveur**.

## Fonctions
- Ajout manuel de serveurs (mot de passe, clé SSH + passphrase, ou agent SSH) et **import mRemoteNG** (`confCons.xml`, connexions SSH uniquement ; dossier 1er niveau = projet, 2e niveau = type).
- Chemin du `.env` par serveur, lecture / édition / écriture via SSH (sauvegarde `.env.bak-AAAAMMJJ-HHMMSS` avant chaque écriture).
- **Infos spécifiques** par serveur (`SERVER_ID`, `IS_JOB_SERVER`…, texte ou booléen), réinjectées dans le `.env` sans toucher au reste du fichier.
- **Uniformiser le .env** : nettoyage de format (LF, espaces, `KEY=value`, sauts de ligne) et, avec un serveur de référence, reprise de son ordre/regroupement/commentaires (les valeurs restent celles de chaque serveur). Aperçu diff avant toute écriture.
- **Commandes en masse** sur les serveurs cochés, résultat par serveur en direct.
- Coffre chiffré (AES-256-GCM, scrypt) protégé par un mot de passe maître. Empreintes SSH mémorisées à la 1re connexion, connexion refusée si elles changent.

## Lancer / builder
```bash
npm install
npm start
npm run dist:win     # exe portable Windows (buildable depuis un Mac, sans wine)
```
Aucun module natif : `.npmrc` exclut les dépendances optionnelles de `ssh2`, qui utilise alors son JS pur.
Mode portable Windows : les données sont dans `env-fleet-data/` à côté de l'exe ; ailleurs, variable `ENV_FLEET_DATA` ou dossier utilisateur.

## Pipeline
`.github/workflows/build.yml` : build Windows / macOS / Linux à chaque push, artefacts téléchargeables ; un tag `vX.Y.Z` publie une Release GitHub.
