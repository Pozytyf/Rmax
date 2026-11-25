# Chantier 1 — PostgreSQL et persistance

Branche : `fix/chore-1-postgresql-persistence`
Merge request : !1 (Draft)

## État : fondations de sécurité et de validation en place ; migration des repositories non terminée

### Diagnostic confirmé
- `src/server/db.ts` et les repositories métier utilisent encore `better-sqlite3` et des appels synchrones.
- `src/server/knex.ts` expose une connexion Knex séparée.
- `api/index.ts` lançait les migrations Knex, interceptait leurs erreurs, puis initialisait SQLite.
- `vercel.json` demande PostgreSQL, mais cela ne migre pas les repositories métier.
- Les deux pools PostgreSQL désactivaient initialement la vérification TLS (`rejectUnauthorized: false`).

### Corrections réalisées
- Refus du fallback SQLite lorsque PostgreSQL est explicitement demandé sans URL de connexion.
- Refus de SQLite en production Vercel et refus de `getDb()` lorsque PostgreSQL est explicitement demandé.
- L'API refuse de démarrer si PostgreSQL est requis mais inaccessible.
- Les erreurs de migrations ne sont plus ignorées.
- Vérification TLS des certificats activée.
- Les migrations ne sont plus exécutées au démarrage des instances serverless/production : le runtime vérifie qu'elles ont déjà été appliquées. En développement local, le démarrage conserve les migrations automatiques SQLite.
- Le contrôle de santé PostgreSQL réutilise désormais le pool Knex de l'application au lieu de créer un deuxième pool concurrent.
- Pipeline GitLab ajouté : typecheck, tests ciblés, tests complets, migrations PostgreSQL, build.
- Tests de configuration et de garde contre les migrations en attente ajoutés.

### Vérification GitLab réellement exécutée
Pipeline `3116401876` (commit `1eb1b333`) :
- TypeScript `tsc --noEmit` : succès.
- Tests ciblés PostgreSQL : succès.
- Suite complète actuelle : **81 tests réussis, 0 échec, 16 fichiers**.
- Migrations sur un service PostgreSQL 16 : les 6 migrations Knex appliquées, statut sans migration en attente, rollback complet du batch, puis réapplication réussie.
- Build Vite/PWA : succès.

Le pipeline est en cours de finalisation ; ces résultats de jobs sont déjà en succès, à l'exception du job smoke-test qui n'a pas encore publié son statut final. Les vérifications sont faites sur une base PostgreSQL éphémère CI, pas sur les données de production.

### Limite bloquante
Les repositories `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et plusieurs services appellent encore SQLite de façon synchrone. La migration de ces couches vers Knex/PostgreSQL exige une conversion asynchrone coordonnée de leurs consommateurs. Le garde-fou ajouté fait échouer ces accès lorsqu'un environnement PG est activé : la branche n'est donc pas déployable tant que la migration n'est pas achevée.

### Suite obligatoire
1. Migrer tous les repositories et appels directs DB vers PostgreSQL asynchrone.
2. Retirer les imports SQLite des chemins runtime production.
3. Revoir toutes les migrations et requêtes SQL sur PostgreSQL réel.
4. Écrire l'outil de migration SQLite → PostgreSQL avec reprise et contrôles de sommes.
5. Tester transactions, rollback, concurrence, persistance multi-instance et restauration.
6. Valider les flux métier avant de passer la MR en Ready.

### Déploiement
Ne pas fusionner ni déployer cette branche en l'état. Aucune migration de données de production n'a été effectuée.
