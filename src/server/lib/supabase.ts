import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getKnex } from '../knex.ts';

export interface SupabaseRuntimeConfig {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  dbUrl: string;
  configured: boolean;
  realtimeReady: boolean;
}

let cachedAdminClient: SupabaseClient | null = null;

export function getSupabaseConfig(): SupabaseRuntimeConfig {
  const url = (
    process.env.SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    ''
  ).trim();
  const anonKey = (
    process.env.SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    ''
  ).trim();
  const serviceRoleKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const dbUrl = (
    process.env.SUPABASE_DB_URL ||
    process.env.DATABASE_URL ||
    ''
  ).trim();

  return {
    url,
    anonKey,
    serviceRoleKey,
    dbUrl,
    configured: Boolean(url && (serviceRoleKey || anonKey)) || Boolean(dbUrl),
    realtimeReady: Boolean(url && anonKey),
  };
}

export function isSupabaseDbUrl(connectionString: string): boolean {
  const lower = connectionString.toLowerCase();
  return (
    lower.includes('supabase.co') ||
    lower.includes('supabase.com') ||
    lower.includes('pooler.supabase')
  );
}

export function getSupabaseAdminClient(): SupabaseClient | null {
  const cfg = getSupabaseConfig();
  if (!cfg.url || !(cfg.serviceRoleKey || cfg.anonKey)) {
    return null;
  }
  if (!cachedAdminClient) {
    cachedAdminClient = createClient(
      cfg.url,
      cfg.serviceRoleKey || cfg.anonKey,
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      },
    );
  }
  return cachedAdminClient;
}

export async function checkSupabaseHealth(): Promise<{
  configured: boolean;
  realtimeReady: boolean;
  postgresConnected: boolean | null;
  latencyMs: number | null;
}> {
  const cfg = getSupabaseConfig();
  const client = (process.env.DATABASE_CLIENT || '').toLowerCase();
  const postgresSelected = ['pg', 'postgres', 'postgresql'].includes(client);

  // Report the database actually selected by the application. Do not create a
  // second pg.Pool solely for health checks: it would duplicate connections.
  if (!cfg.dbUrl || !postgresSelected) {
    return {
      configured: cfg.configured,
      realtimeReady: cfg.realtimeReady,
      postgresConnected: null,
      latencyMs: null,
    };
  }

  const startedAt = Date.now();
  try {
    await getKnex().raw('SELECT 1');
    return {
      configured: cfg.configured,
      realtimeReady: cfg.realtimeReady,
      postgresConnected: true,
      latencyMs: Date.now() - startedAt,
    };
  } catch {
    return {
      configured: cfg.configured,
      realtimeReady: cfg.realtimeReady,
      postgresConnected: false,
      latencyMs: Date.now() - startedAt,
    };
  }
}

export function resetSupabaseSingletonsForTest(): void {
  cachedAdminClient = null;
}
