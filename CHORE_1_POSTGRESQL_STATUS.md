# Chantier 1 — PostgreSQL et persistance

Branche : `fix/chore-1-postgresql-persistence`

## État : sécurisation initiale, migration métier non terminée

### Constat confirmé
- `src/server/db.ts` et les repositories métier utilisent encore `better-sqlite3` et des appels synchrones.
- `src/server/knex.ts` expose une connexion Knex séparée.
- `api/index.ts` lançait les migrations Knex, interceptait leurs erreurs, puis initialisait SQLite.
- `vercel.json` demande PostgreSQL, mais cela ne migre pas les repositories métier vers PostgreSQL.
- La configuration TLS PostgreSQL désactivait la vérification des certificats (`rejectUnauthorized: false`) dans les deux pools observés.

### Corrections effectuées dans cette branche
- Refus du fallback SQLite lorsque PostgreSQL est explicitement demandé sans URL de connexion.
- Refus de SQLite en production Vercel.
- `getDb()` refuse SQLite lorsque PostgreSQL est explicitement demandé.
- L'API refuse de démarrer si PostgreSQL est requis mais inaccessible.
- Les erreurs de migrations Knex ne sont plus ignorées.
- Vérification des certificats TLS activée pour les connexions PostgreSQL/Supabase.
- Ajout de tests de configuration PostgreSQL et mise à jour du test TLS.
- Ajout de `npm run test:postgres-config`.
- Ajout d'un pipeline GitLab avec typecheck, tests existants, test de configuration PostgreSQL et build reproductible à partir de `bun.lock`.

### Limite bloquante
Les repositories `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et plusieurs services appellent encore SQLite de façon synchrone. La migration de ces couches vers Knex/PostgreSQL exige une conversion asynchrone coordonnée de leurs consommateurs. Le garde-fou ajouté fait échouer ces accès lorsqu'un environnement PG est activé : la branche n'est donc pas déployable tant que la migration n'est pas achevée.

### Suite obligatoire
1. Migrer tous les repositories et appels directs DB vers PostgreSQL asynchrone.
2. Retirer les imports SQLite des chemins runtime production.
3. Revoir toutes les migrations et requêtes SQL sur PostgreSQL réel.
4. Écrire l'outil de migration de données SQLite → PostgreSQL avec reprise et contrôles de sommes.
5. Tester transactions, rollback, concurrence, persistance multi-instance et restauration.
6. Valider les flux métier avant de passer la MR en Ready.

### Déploiement
Ne pas fusionner ni déployer cette branche en l'état. Le pipeline nouvellement ajouté doit d'abord être exécuté et ses résultats examinés. Aucune migration de données de production n'a été effectuée.
