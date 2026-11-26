# Déploiement Resto’MAX — Supabase PostgreSQL + Vercel

> **État au 26 novembre 2026 : ne pas considérer cette branche comme prête pour la production.** Les garde-fous PostgreSQL, le schéma, les politiques RLS et la CI ont été renforcés, mais les repositories métier historiques utilisent encore SQLite et doivent être migrés vers Knex/PostgreSQL asynchrone.

## 1. Initialiser PostgreSQL

Créer ou sélectionner le projet Supabase cible, puis sauvegarder les identifiants et la chaîne de connexion dans un gestionnaire de secrets.

### Installation neuve

1. Ouvrir Supabase → SQL Editor.
2. Exécuter `supabase/schema.sql`.
3. Exécuter `supabase/seed.sql` uniquement dans un environnement de démonstration ou de test.
4. Exécuter les migrations SQL de durcissement `supabase/migrations/202611260010_*.sql` à `202611260014_*.sql` dans l'ordre.

### Projet déjà initialisé avec Knex

1. Configurer temporairement `DATABASE_CLIENT=pg`, `DATABASE_URL` et `DATABASE_SSL=true`.
2. Exécuter `npm run migrate:latest` (migrations Knex 001 à 009).
3. Exécuter les migrations Supabase SQL 010 à 014 dans l'ordre.
4. Vérifier que `knex_migrations` ne contient aucune migration en attente.
5. Exécuter les contrôles CI PostgreSQL et les tests métier avant toute bascule.

Les migrations SQL 010 à 014 :
- retirent l'exécution publique de la fonction interne `rls_auto_enable()` ;
- ajoutent les tables opérationnelles absentes ;
- définissent les fonctions de lecture des claims tenant avec `search_path` fixé ;
- ajoutent les politiques d'isolation tenant aux tables existantes ;
- bloquent explicitement l'accès Data API aux tables sensibles internes.

Ne pas exécuter `seed.sql` sur une base contenant déjà des données métier sans avoir vérifié son contenu et son idempotence.

## 2. Variables d'environnement

Configurer dans Vercel (Production, Preview et Development selon les besoins) :

- `NODE_ENV=production`
- `DATABASE_CLIENT=pg`
- `DATABASE_URL` ou `SUPABASE_DB_URL` : URI PostgreSQL Supabase, de préférence Transaction Pooler adaptée au runtime serverless.
- `DATABASE_SSL=true`
- `DB_POOL_MIN=0`
- `DB_POOL_MAX=5`
- `JWT_SECRET` : secret aléatoire fort d'au moins 32 octets, idéalement 64 caractères ou plus.
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` : secret serveur uniquement, jamais préfixé `VITE_`.
- `APP_URL`
- paramètres PayDunya, SMTP et autres fournisseurs uniquement dans les secrets du serveur.

Ne jamais exposer `DATABASE_URL`, `SUPABASE_DB_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET`, clés privées de paiement ou mots de passe SMTP dans le bundle frontend.

## 3. Migrations en production

Les instances serverless ne doivent pas exécuter `migrate:latest` à chaque démarrage. La fonction API vérifie désormais que le schéma est déjà à jour et refuse de démarrer si des migrations sont en attente.

Exécuter les migrations dans une étape de release unique, avant le déploiement applicatif. Conserver un backup vérifié avant toute migration de données.

Commandes locales :

```bash
DATABASE_CLIENT=pg DATABASE_URL="$DATABASE_URL" DATABASE_SSL=true npm run migrate:latest
DATABASE_CLIENT=pg DATABASE_URL="$DATABASE_URL" DATABASE_SSL=true npm run migrate:rollback
```

Ne pas utiliser le rollback global sur une base de production sans plan de reprise : certaines migrations de schéma ne doivent pas être annulées après l'écriture de données métier.

## 4. RLS et authentification Supabase

Les politiques RLS s'appuient sur les claims signés `restaurant_id` ou `app_metadata.restaurant_id`, et `global_role=SUPER_ADMIN`. Les tables `users`, `sessions`, `auth_tokens` et les tables de migrations sont bloquées pour les rôles Data API.

**Important :** le JWT applicatif Resto’MAX signé par `JWT_SECRET` n'est pas automatiquement un JWT Supabase. Le navigateur doit recevoir un JWT Supabase de confiance et le transmettre à Realtime avec `supabase.realtime.setAuth(token)` avant que les abonnements tenant puissent être déclarés fonctionnels.

Ne jamais créer de policy `anon` qui autorise la lecture des commandes, paiements, stocks ou clients sur la seule base d'un `restaurant_id` fourni dans l'URL ou le filtre Realtime.

Le rôle PostgreSQL propriétaire utilisé par Knex peut contourner RLS. Par conséquent, les repositories backend doivent également dériver le tenant de la session vérifiée et appliquer explicitement le filtre tenant à chaque requête.

## 5. Contrôles avant ouverture de production

- [ ] Toutes les migrations Knex et Supabase SQL sont appliquées.
- [ ] Aucun repository métier n'utilise SQLite en production.
- [ ] Une commande créée sur une instance est lue sur une autre.
- [ ] Tests de transactions, rollback, concurrence et idempotence réussis.
- [ ] Tests d'isolation avec au moins deux restaurants réels et plusieurs rôles.
- [ ] RLS testé avec des JWT Supabase signés, pas uniquement avec des tests statiques.
- [ ] Realtime testé avec JWT et canaux autorisés.
- [ ] Paiements testés avec les environnements sandbox des prestataires.
- [ ] Backup et restauration testés.
- [ ] Build, tests, TypeScript et pipeline GitLab réussis.

## 6. État technique réel

- PostgreSQL/Knex : configuration, migrations et smoke tests PostgreSQL en CI.
- Schéma : 11 tables opérationnelles manquantes ajoutées ; contraintes et index métier ajoutés.
- Supabase RLS : 46 politiques sur 46 tables publiques dans le projet inspecté ; l'advisor de sécurité ne retourne aucun finding après les migrations de durcissement.
- Persistance métier : **incomplète**. `authRepository`, `publicRepository`, `restaurantRepository`, `operationsRepository`, `superadminRepository`, `BaseRepository`, middleware et services consommateurs doivent encore être convertis à Knex asynchrone.
- Migration des données SQLite historiques : non réalisée.
- Authentification Realtime Supabase : non terminée.
- Déploiement production : non autorisé tant que les points précédents ne sont pas validés.

La présence d'une table, d'une route ou d'un composant dans le dépôt ne prouve pas que son parcours métier est fonctionnel de bout en bout.
