# Chantier 1 — PostgreSQL et persistance

Branche : `fix/chore-1-postgresql-persistence`

## État d'avancement : tranche de sécurisation initiale

Cette branche démarre le durcissement de la configuration PostgreSQL. Elle ne constitue pas encore la migration complète des repositories métier.

## Constat confirmé

- `src/server/db.ts` crée une instance `better-sqlite3` et expose une API synchrone.
- Les repositories historiques appellent directement `getDb()` et utilisent `.prepare()`.
- `src/server/knex.ts` expose une connexion Knex distincte.
- `api/index.ts` lançait les migrations Knex, interceptait leurs erreurs, puis initialisait SQLite.
- `vercel.json` demande PostgreSQL, mais cela ne migre pas les repositories métier vers PostgreSQL.

## Changements réalisés dans cette tranche

- La sélection explicite de PostgreSQL échoue si `SUPABASE_DB_URL` et `DATABASE_URL` sont absents ; aucun fallback SQLite silencieux n'est accepté dans Knex.
- Le runtime Vercel en production refuse la configuration SQLite.
- `getDb()` refuse désormais de créer/utiliser SQLite lorsque PostgreSQL est explicitement demandé ou en production Vercel. Cela empêche le mélange silencieux des deux moteurs.
- L'initialisation API échoue si PostgreSQL est requis mais inaccessible.
- Les erreurs de migration Knex ne sont plus ignorées.
- Ajout de tests ciblés pour les règles de configuration.
- Ajout de la commande `npm run test:postgres-config`.

## Limite importante

Les repositories métier utilisent encore SQLite. En conséquence, lorsque PostgreSQL est demandé, les opérations métier qui appellent `getDb()` échoueront volontairement jusqu'à leur migration. Cette branche ne doit donc pas être déployée telle quelle en production. Ce garde-fou évite de continuer à écrire dans une base SQLite éphémère et de faire croire que les données sont persistantes.

## Travaux nécessaires avant mise en production

1. Migrer `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et les autres accès directs à `getDb()`.
2. Adapter les services et controllers aux méthodes asynchrones.
3. Vérifier la compatibilité PostgreSQL de toutes les migrations et requêtes SQL.
4. Mettre en place une migration de données SQLite vers PostgreSQL avec contrôles de cohérence.
5. Ajouter des tests d'intégration sur un vrai PostgreSQL.
6. Vérifier les transactions, verrous, contraintes, index et concurrence.
7. Retirer définitivement SQLite des chemins de production après migration de tous les repositories.

## Déploiement

Ne pas déployer cette tranche seule sur la production actuelle. Elle constitue un garde-fou de développement, pas une migration terminée. La mise en production doit attendre la migration des repositories et la validation des tests PostgreSQL.
