# Chantier 1 — PostgreSQL et persistance

Branche : `fix/chore-1-postgresql-persistence`

## État d'avancement

Cette branche démarre le durcissement de la configuration PostgreSQL. Elle ne constitue pas encore la migration complète des repositories métier.

## Constat confirmé

- `src/server/db.ts` crée une instance `better-sqlite3` et expose une API synchrone.
- Les repositories historiques appellent directement `getDb()` et utilisent `.prepare()`.
- `src/server/knex.ts` expose une connexion Knex séparée.
- `api/index.ts` lançait les migrations Knex, interceptait leurs erreurs, puis initialisait SQLite.
- `vercel.json` demande PostgreSQL, mais cela ne migre pas les repositories métier vers PostgreSQL.

## Changements de cette première tranche

- La sélection explicite de PostgreSQL échoue désormais si `SUPABASE_DB_URL` et `DATABASE_URL` sont absents ; aucun fallback SQLite silencieux n'est accepté.
- Le runtime Vercel en production refuse la configuration SQLite.
- L'initialisation API échoue si PostgreSQL est requis mais inaccessible.
- Les erreurs de migration Knex ne sont plus ignorées.
- L'initialisation API ne crée plus inutilement une base SQLite au démarrage.
- Ajout de tests ciblés pour ces règles de configuration.

## Travaux encore nécessaires avant une migration complète

1. Migrer `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et les autres accès directs à `getDb()`.
2. Adapter les services et controllers aux méthodes asynchrones.
3. Vérifier la compatibilité PostgreSQL de toutes les migrations et requêtes SQL.
4. Mettre en place une migration de données SQLite vers PostgreSQL avec contrôles de cohérence.
5. Ajouter des tests d'intégration sur un vrai PostgreSQL.
6. Vérifier les transactions, verrous, contraintes, index et concurrence.
7. Retirer définitivement SQLite des chemins de production après migration de tous les repositories.

## Déploiement

Ne pas déployer cette tranche seule sur la production actuelle : les repositories métier utilisent encore SQLite. Cette tranche empêche certains fallbacks dangereux et rend les erreurs de configuration/migration visibles, mais elle ne suffit pas à rendre toutes les opérations métier persistantes dans PostgreSQL.
