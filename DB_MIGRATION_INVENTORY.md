# Inventaire des accès SQLite à migrer

État du dépôt sur la branche `fix/chore-1-postgresql-persistence` au 26/11/2026. Les compteurs ci-dessous sont le relevé initial et ne sont pas recalculés après les derniers commits.
Les nombres ci-dessous sont des occurrences statiques relevées dans les fichiers, pas un décompte d'opérations exécutées en production.

| Fichier | `getDb()` | `.prepare()` | `.exec()` |
|---|---:|---:|---:|
| `src/server/auth.ts` | 1 | 3 | 0 |
| `src/server/repositories/BaseRepository.ts` | 1 | 6 | 3 |
| `src/server/repositories/authRepository.ts` | 21 | 31 | 0 |
| `src/server/repositories/operationsRepository.ts` | 23 | 35 | 0 |
| `src/server/repositories/publicRepository.ts` | 25 | 32 | 0 |
| `src/server/repositories/restaurantRepository.ts` | 95 | 226 | 0 |
| `src/server/repositories/superadminRepository.ts` | 32 | 59 | 0 |
| `src/server/services/authService.ts` | 11 | 1 | 9 |
| `src/server/services/operationsService.ts` | 16 | 39 | 15 |
| `src/server/services/publicService.ts` | 10 | 2 | 15 |
| `src/server/services/restaurantService.ts` | 28 | 1 | 30 |
| `src/server/services/superadminService.ts` | 18 | 0 | 9 |
| **Total** | **281** | **435** | **81** |

## Avancement après le premier vertical slice

### Authentification
- `KnexAuthRepository` ajouté et utilisé en production par `AuthService`.
- Sessions, utilisateurs, memberships, tokens, audits et transactions passent par Knex/PostgreSQL.
- L'ancien `authRepository.ts` reste présent pour les fixtures SQLite historiques et les fonctions superadmin qui ne sont pas encore migrées.

### Public / QR / storefront — lectures et petites mutations
- `publicRepository.knex.ts` ajouté pour les plans, paramètres publics, leads, contexte QR, storefront, catégories, articles disponibles, sessions QR, statistiques/avis, noms de serveurs et suivi des commandes QR/storefront ; ajout aussi des mutations d'appels de table et d'avis clients.
- `operationsRepository.knex.ts` ajoute la lecture Knex des combos et promotions utilisées pour construire le catalogue public.
- `publicService` et `publicController` utilisent désormais ces opérations asynchrones en production : plans, paramètres, formulaire contact/démo, catalogue QR/storefront, lookup fidélité, suivi des commandes, appels serveur/addition et avis clients.
- Les mutations de commandes publiques, paiements, appels serveur, avis et écritures financières ne sont PAS encore migrées ; elles restent bloquantes pour la mise en production PostgreSQL.

### Schéma
- Migration Knex 016 / migration SQL Supabase 017 : `menu_items.option_groups_json`.
- Migration Knex 017 / migration SQL Supabase 018 : téléphone client, adresse/zone/frais de livraison, créneau, code promo et points fidélité sur `orders`.
- Les champs d'ordres publics ont également été ajoutés au schéma SQLite local, avec ajout idempotent sur les bases locales déjà existantes.

### Second vertical slice — 26/11/2026

Les parcours suivants ont maintenant une implémentation Knex et sont sélectionnés par les services lorsque `DATABASE_CLIENT=pg` :

- Catalogue restaurant : lecture des catégories, articles et recettes, avec jointures stock explicitement limitées au même restaurant.
- Formules / combos : lecture, création, modification et suppression avec filtres `restaurant_id`.
- Promotions : lecture, création, modification et suppression avec filtres `restaurant_id`.
- Appels de table : lecture et acquittement tenant-scopés.
- Fidélité : historique et ajustement transactionnel avec verrouillage `FOR UPDATE`, journal de mouvement et audit dans la même transaction.
- Avis clients : lecture et réponse tenant-scopée.
- Inventaires : lecture des en-têtes et lignes avec jointure des stocks bornée au restaurant.
- Planning et pointages : lectures des horaires et des temps de présence, création et suppression des créneaux.
- Caisse : lecture des rapports, ouverture et clôture transactionnelles ; verrouillage de la ligne restaurant à l'ouverture et de la session à la clôture.
- Factures B2B : lecture tenant-scopée.
- Paramètres de plateforme : lecture et upsert PostgreSQL, avec audit dans la même transaction.

Corrections de revue associées :
- Suppression d'un bloc de dix méthodes dupliquées dans `publicRepository.knex.ts`, qui créait des implémentations de classe redondantes.
- Initialisation explicite du pool Knex dans le repository restaurant qui exécute désormais les lectures de menu.
- Alignement des flags `active`, `available` et `is_daily_special` sur le schéma PostgreSQL existant (entiers 0/1, pas booléens).
- Suppression de la variable de production `PAYMENT_MODE=TEST`, qui contredisait le mode PayDunya LIVE déclaré dans Vercel.

Un test d'intégration PostgreSQL couvre les lectures menu, le CRUD combos/promotions et l'isolation entre restaurants. Il est ajouté à `scripts/postgres-health.integration.test.ts`, mais n'a pas encore pu être exécuté dans GitLab CI.

## Conséquence

Le basculement de la variable `DATABASE_CLIENT=pg` ne suffit pas. Ces appels synchrones doivent être remplacés par des opérations Knex asynchrones et leurs consommateurs doivent être adaptés.

La conversion doit conserver :
- la forme des objets renvoyés aux services et contrôleurs ;
- les règles de validation métier ;
- les transactions multi-requêtes et leur rollback ;
- les filtres tenant explicites ;
- les clés d'idempotence ;
- les types et valeurs par défaut SQLite/PostgreSQL ;
- les tests de parcours et les effets secondaires (audit, notifications, mouvements de stock).

## Ordre de migration proposé

1. Terminer `authRepository` côté superadmin et migrer les écritures publiques/commandes/paiements de `publicRepository` + `publicService`.
2. `restaurantRepository` + `restaurantService` : POS, commandes, tables, menus, stocks, finance.
3. Terminer `operationsRepository` + `operationsService` (caisse, inventaires/écarts, déchets, pointages, écritures B2B et multi-sites).
4. `superadminRepository` + `superadminService`.
6. `BaseRepository`, `BaseService` et suppression des accès SQLite résiduels.
7. Migration des données et validation complète multi-instance.

Ne pas supprimer `better-sqlite3` avant que tous les chemins runtime métier aient été migrés et testés.
