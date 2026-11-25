import type { IncomingMessage, ServerResponse } from 'node:http';
import { createExpressApp } from '../src/server/app.ts';
import { runKnexMigrations } from '../src/server/knex.ts';
import {
  checkSupabaseHealth,
  getSupabaseAdminClient,
} from '../src/server/lib/supabase.ts';

const app = createExpressApp();
let initPromise: Promise<void> | null = null;

async function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const databaseClient = (process.env.DATABASE_CLIENT || '').toLowerCase();
      const postgresRequired = ['pg', 'postgres', 'postgresql'].includes(databaseClient);

      if (postgresRequired) {
        const databaseUrl = process.env.SUPABASE_DB_URL || process.env.DATABASE_URL;
        if (!databaseUrl) {
          throw new Error(
            'Configuration invalide : DATABASE_CLIENT=pg exige SUPABASE_DB_URL ou DATABASE_URL.',
          );
        }
      }

      getSupabaseAdminClient();
      const sbHealth = await checkSupabaseHealth();
      if (postgresRequired && sbHealth.postgresConnected !== true) {
        throw new Error(
          'PostgreSQL est requis mais le contrôle de connexion a échoué. L’API refuse de démarrer plutôt que de continuer avec une base de secours.',
        );
      }

      // Les erreurs de migration doivent empêcher le démarrage : les ignorer
      // pourrait laisser le schéma en retard par rapport au code déployé.
      await runKnexMigrations();
    })().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  await ensureInitialized();
  return app(req as Parameters<typeof app>[0], res as Parameters<typeof app>[1]);
}
