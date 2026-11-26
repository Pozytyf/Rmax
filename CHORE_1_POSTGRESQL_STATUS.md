# Resto’MAX — suivi technique des chantiers

Branche de travail : `fix/chore-1-postgresql-persistence`
Merge request : !1 (Draft)
Dernier pipeline complet validé : [3117648302](https://gitlab.com/multitachesci/Kokolia/-/pipelines/3117648302)

## Chantier 1 — PostgreSQL et persistance

### État
Fondations de configuration, migrations, intégrité de schéma, CI et parcours d'authentification PostgreSQL validés. **Migration des repositories métier reste incomplète** : commandes, QR/storefront, stocks, opérations et superadmin utilisent encore en partie SQLite. Ce chantier n'est donc pas clos et la branche n'est pas déployable en production.

### Diagnostic confirmé
- `src/server/db.ts` et les repositories historiques utilisent encore `better-sqlite3` et des appels synchrones.
- `src/server/knex.ts` expose une connexion Knex distincte.
- L'API exécutait des migrations Knex puis initialisait SQLite ; les erreurs de migration étaient auparavant ignorées.
- La configuration PostgreSQL désactivait initialement la validation TLS.
- Comparaison du schéma SQLite historique et du schéma Knex : 11 tables opérationnelles manquaient dans PostgreSQL.
- Inspection initiale Supabase du projet `RestoMax V1` : 35 tables, RLS activé, aucune politique dans `pg_policies`, une seule clé étrangère métier (`users.tenant_id → tenants.id`), six migrations Knex enregistrées et aucune ligne métier. L'event trigger `ensure_rls` était actif.
- Le JWT applicatif Resto’MAX est signé avec `JWT_SECRET`, alors que le navigateur utilise Supabase Realtime avec la seule clé anon et n'appelle pas `realtime.setAuth()`. Les politiques tenant exigent un JWT Supabase de confiance contenant `restaurant_id` ou `app_metadata.restaurant_id`; le pont d'authentification Realtime reste à construire.

### Corrections réalisées
- Refus du fallback SQLite lorsque PostgreSQL est explicitement demandé sans URL.
- Refus de SQLite sur Vercel en production et refus de `getDb()` lorsque PostgreSQL est demandé.
- L'API échoue si PostgreSQL est requis mais indisponible.
- Les erreurs de migrations ne sont plus ignorées.
- Vérification des certificats TLS activée.
- Les migrations sont sorties du démarrage de chaque instance production/serverless ; le runtime vérifie leur état. Les migrations locales restent automatiques en développement.
- Migration du parcours d'authentification vers `KnexAuthRepository` asynchrone en production : connexion, inscription, sessions, bascule de restaurant, PIN, vérification email, reset/changement de mot de passe et révocation.
- Ajout de `recordAuditWithKnex` et `resolveAuthContextWithKnex`; les middlewares d'authentification et la vérification des sessions passent par PostgreSQL en production.
- Les changements de mot de passe et la consommation des jetons de vérification/reset sont transactionnels et verrouillés contre la réutilisation concurrente.
- La création d'un restaurant crée aussi la ligne `tenants` requise par la FK `users.tenant_id`.
- Ajout de la migration Knex `202611260015_seed_default_saas_plans.ts` : les plans Essentiel, Professionnel et Premium existent dès l'initialisation PostgreSQL, sans créer de restaurants ou comptes de démonstration.
- `JWT_SECRET` est désormais obligatoire en production et doit faire au moins 32 octets ; les tokens sont vérifiés avec l'algorithme HS256 explicitement.
- Les salles WebSocket de commande exigent soit une session restaurant autorisée, soit un QR actif lié à la même table que la commande. Le navigateur QR transmet son jeton de table pour l'accès public limité.
- Le health check réutilise le pool Knex de l'application.
- Ajout des 11 tables opérationnelles manquantes.
- RLS activé explicitement sur les nouvelles tables métier, avec politiques tenant basées sur des claims vérifiés et sans accès métier anonyme.
- Application sur Supabase `RestoMax V1` des migrations SQL 010 à 014 : le schéma compte maintenant 46 tables et 46 politiques RLS. Les tables sensibles (`users`, `sessions`, `auth_tokens`, `knex_migrations`, `knex_migrations_lock`) ont des politiques deny-all et aucun privilège Data API.
- Ajout de clés étrangères manquantes entre restaurants, membres, utilisateurs, commandes, lignes, paiements, stocks, recettes, achats, fidélité, inventaires et personnel. Les contraintes sont ajoutées `NOT VALID` puis validées, et les doublons équivalents déjà déclarés sont ignorés.
- Ajout d'un index unique sur `(restaurant_id, order_number)` après contrôle préalable des doublons.
- Ajout d'index sur les colonnes FK de caisse, fidélité et appels de table. L'advisor Supabase performance ne signale plus de clés étrangères non indexées ; les index inutilisés sont attendus sur une base sans charge métier.
- Ajout d'une CI avec typecheck, tests unitaires/routes, migrations PostgreSQL, smoke test PostgreSQL, build.
- Durcissement appliqué directement sur Supabase `RestoMax V1` : retrait des privilèges d'exécution de `public.rls_auto_enable()` pour `PUBLIC`, `anon` et `authenticated`; `search_path=pg_catalog` fixé sur les fonctions RLS; création des 11 tables métier manquantes; ajout des politiques tenant et politiques enfants; accès Data API révoqué pour les tables sensibles internes. L'event trigger `ensure_rls` reste actif.
- Ajout de tests pour les règles de configuration, le verrou de migrations, la présence des tables, RLS, clés étrangères et unicité des numéros de commande.

### Validation réelle GitLab
Pipeline [3117648302](https://gitlab.com/multitachesci/Kokolia/-/pipelines/3117648302) : **succès sur les 7 jobs**.
- `tsc --noEmit` : succès.
- Tests ciblés de configuration : succès.
- Suite complète : **78 tests sur 15 fichiers, 0 échec**.
- Migrations sur PostgreSQL 16 : migrations Knex 001 à 009 et 015 appliquées ; état sans migration en attente ; rollback complet du batch puis réapplication réussie.
- Smoke test PostgreSQL : connexion, schéma, RLS sur les 11 nouvelles tables, clés étrangères et index unique vérifiés.
- Test d'intégration PostgreSQL du repository d'authentification : création tenant/restaurant/utilisateur/membership/session, lecture utilisateur/venues, token à usage unique, résolution JWT, révocation de session et audit vérifiés.
- Test SQL Supabase : 46 politiques, privilèges, search_path et lecture/écriture inter-tenant refusées vérifiés sur PostgreSQL 16.
- Test de bootstrap Supabase : schéma initial + migrations SQL 011 à 014, 46 politiques et grants vérifiés.
- Build Vite/PWA : succès.

Le build signale encore un bundle frontend principal supérieur à 700 kB ; c'est une optimisation de performance à traiter dans le chantier UX/performance.

### Inventaire des accès SQLite
Le relevé statique initial comptait 281 appels `getDb()`, 435 appels `.prepare()` et 81 appels `.exec()` dans les repositories, le middleware et les services. L'authentification a été partiellement sortie de ces chemins, mais le reste des repositories métier n'est pas encore migré. Le détail par fichier et l'ordre de conversion sont consignés dans `DB_MIGRATION_INVENTORY.md`.

### Travaux bloquants avant clôture
1. Terminer le retrait du repository SQLite historique `authRepository` pour les fonctions superadmin et migrer `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et `BaseRepository` vers un accès Knex asynchrone.
2. Convertir leurs services, controllers et middleware consommateurs, y compris transactions et rollback.
3. Éliminer tous les accès métier directs à `getDb()` dans les chemins de production.
4. Tester l'ensemble des parcours métier sur PostgreSQL réel, pas seulement les migrations.
5. Créer un outil SQLite → PostgreSQL avec reprise, préservation des identifiants/relations, contrôles de volumes et sommes financières.
6. Tester persistance après redémarrage, multi-instance, concurrence, intégrité et restauration.
7. Mettre en place une authentification Realtime Supabase fiable avant d'ajouter des policies RLS permettant l'accès du navigateur.

### Sécurité Supabase — état après correction
- 46 politiques RLS sur 46 tables publiques.
- Advisor Supabase sécurité : aucun finding.
- Test RLS réel sur `RestoMax V1`, exécuté dans une transaction annulée : avec un JWT de test `restaurant_id=A`, le rôle `authenticated` ne voit que la commande du restaurant A (`visible_orders=1`), ne peut pas mettre à jour la commande du restaurant B (`cross_tenant_updates=0`) et une insertion inter-tenant est rejetée par RLS. Les fixtures ont été annulées ; aucune donnée métier n'a été conservée.
- `anon` ne peut pas lire les commandes ; `authenticated` a le privilège SQL mais reste limité par les politiques tenant.
- `users`, `sessions`, `auth_tokens` et les tables de migration sont explicitement refusées aux rôles Data API.
- `public.rls_auto_enable()` n'est plus exécutable par `PUBLIC`, `anon` ou `authenticated`; l'event trigger `ensure_rls` reste actif.
- Les fonctions tenant ont `search_path=pg_catalog`.

Le JWT du navigateur n'est pas encore transmis à Supabase Realtime. Les politiques RLS sont vérifiées directement au niveau PostgreSQL, mais les abonnements tenant Realtime ne sont pas certifiés fonctionnels tant que le pont d'authentification Supabase n'est pas réalisé. Le backend SQL utilise une connexion privilégiée et doit continuer à appliquer explicitement le tenant dans chaque repository.

### Déploiement
Ne pas fusionner ni déployer cette branche en l'état. Les garde-fous SQLite rendent volontairement les opérations métier encore non migrées indisponibles quand PostgreSQL est sélectionné. Aucune migration de données métier de production n'a été réalisée.
