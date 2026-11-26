# Resto’MAX — suivi technique des chantiers

Branche de travail : `fix/chore-1-postgresql-persistence`
Merge request : !1 (Draft)
Dernier pipeline complet validé : [3117518872](https://gitlab.com/multitachesci/Kokolia/-/pipelines/3117518872)

## Chantier 1 — PostgreSQL et persistance

### État
Fondations de configuration, migrations, intégrité de schéma et CI validées. **Migration des repositories métier vers PostgreSQL non terminée**. Ce chantier n'est donc pas clos et la branche n'est pas déployable en production.

### Diagnostic confirmé
- `src/server/db.ts` et les repositories historiques utilisent encore `better-sqlite3` et des appels synchrones.
- `src/server/knex.ts` expose une connexion Knex distincte.
- L'API exécutait des migrations Knex puis initialisait SQLite ; les erreurs de migration étaient auparavant ignorées.
- La configuration PostgreSQL désactivait initialement la validation TLS.
- Comparaison du schéma SQLite historique et du schéma Knex : 11 tables opérationnelles manquaient dans PostgreSQL.
- Inspection Supabase du projet nommé `RestoMax V1` : 35 tables présentes à l'inspection, RLS activé, aucune politique trouvée dans `pg_policies`, et une seule clé étrangère métier existante (`users.tenant_id → tenants.id`). Le projet contient six migrations Knex enregistrées et aucune ligne métier lors de l'inspection. L'event trigger `ensure_rls` était actif.
- Le JWT applicatif Resto’MAX est signé avec `JWT_SECRET`, alors que le navigateur utilise Supabase Realtime avec la seule clé anon et n'appelle pas `realtime.setAuth()`. Les policies basées sur `auth.jwt()->>'restaurant_id'` ne peuvent donc pas être activées sans mettre en place une identité Supabase signée de confiance.

### Corrections réalisées
- Refus du fallback SQLite lorsque PostgreSQL est explicitement demandé sans URL.
- Refus de SQLite sur Vercel en production et refus de `getDb()` lorsque PostgreSQL est demandé.
- L'API échoue si PostgreSQL est requis mais indisponible.
- Les erreurs de migrations ne sont plus ignorées.
- Vérification des certificats TLS activée.
- Les migrations sont sorties du démarrage de chaque instance production/serverless ; le runtime vérifie leur état. Les migrations locales restent automatiques en développement.
- Le health check réutilise le pool Knex de l'application.
- Ajout des 11 tables opérationnelles manquantes.
- RLS activé explicitement sur les nouvelles tables métier, sans politique permissive non authentifiée.
- Ajout de clés étrangères manquantes entre restaurants, membres, utilisateurs, commandes, lignes, paiements, stocks, recettes, achats, fidélité, inventaires et personnel. Les contraintes sont ajoutées `NOT VALID` puis validées, et les doublons équivalents déjà déclarés sont ignorés.
- Ajout d'un index unique sur `(restaurant_id, order_number)` après contrôle préalable des doublons.
- Ajout d'une CI avec typecheck, tests unitaires/routes, migrations PostgreSQL, smoke test PostgreSQL, build.
- Durcissement appliqué directement sur le projet Supabase `RestoMax V1` : retrait des privilèges d'exécution de `public.rls_auto_enable()` pour `PUBLIC`, `anon` et `authenticated`. Vérification après changement : `anon_can_execute=false`, `authenticated_can_execute=false`, event trigger `ensure_rls` toujours activé. L'advisor Supabase ne signale plus l'exposition de cette fonction.
- Ajout de tests pour les règles de configuration, le verrou de migrations, la présence des tables, RLS, clés étrangères et unicité des numéros de commande.

### Validation réelle GitLab
Pipeline [3117518872](https://gitlab.com/multitachesci/Kokolia/-/pipelines/3117518872) : **succès sur les six jobs**.
- `tsc --noEmit` : succès.
- Tests ciblés de configuration : succès.
- Suite complète actuelle : 81 tests réussis, 0 échec.
- Migrations sur PostgreSQL 16 : migrations 001 à 009 appliquées, état sans migration en attente, rollback complet du batch puis réapplication réussie.
- Smoke test PostgreSQL : connexion, schéma, RLS sur les 11 nouvelles tables, clés étrangères et index unique vérifiés.
- Build Vite/PWA : succès.

Le build signale encore un bundle frontend principal supérieur à 700 kB ; c'est une optimisation de performance à traiter dans le chantier UX/performance.

### Travaux bloquants avant clôture
1. Migrer les repositories `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository` et `BaseRepository` vers un accès Knex asynchrone.
2. Convertir leurs services, controllers et middleware consommateurs, y compris transactions et rollback.
3. Éliminer tous les accès métier directs à `getDb()` dans les chemins de production.
4. Tester l'ensemble des parcours métier sur PostgreSQL réel, pas seulement les migrations.
5. Créer un outil SQLite → PostgreSQL avec reprise, préservation des identifiants/relations, contrôles de volumes et sommes financières.
6. Tester persistance après redémarrage, multi-instance, concurrence, intégrité et restauration.
7. Mettre en place une authentification Realtime Supabase fiable avant d'ajouter des policies RLS permettant l'accès du navigateur.

### Sécurité Supabase — état après correction
Le problème d'exécution RPC de `public.rls_auto_enable()` a été corrigé sur le projet `RestoMax V1` via une migration Supabase : les rôles `PUBLIC`, `anon` et `authenticated` n'ont plus le droit d'exécuter la fonction. Contrôle post-migration : les deux rôles applicatifs sont refusés et l'event trigger `ensure_rls` reste activé. L'advisor de sécurité ne remonte plus ce finding.

Il reste 35 tables avec RLS activé mais sans politiques. L'accès navigateur doit rester refusé tant qu'une identité Supabase signée et liée au restaurant n'est pas mise en place ; le backend doit utiliser un rôle serveur protégé. Les policies Realtime ne sont pas encore activées.

### Déploiement
Ne pas fusionner ni déployer cette branche en l'état. Les garde-fous SQLite rendent volontairement les opérations métier encore non migrées indisponibles quand PostgreSQL est sélectionné. Aucune migration de données métier de production n'a été réalisée.
