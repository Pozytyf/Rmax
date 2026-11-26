import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to validate Supabase SQL migrations.');
}

const client = new Client({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

const migrationFiles = [
  '202611260010_revoke_public_rls_trigger_execute.sql',
  '202611260011_add_operations_schema_and_rls.sql',
  '202611260012_pin_tenant_function_search_path.sql',
  '202611260013_apply_existing_tenant_rls.sql',
  '202611260014_deny_api_access_to_internal_tables.sql',
];

async function main(): Promise<void> {
  await client.connect();
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END
      $$;
      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE OR REPLACE FUNCTION auth.jwt()
      RETURNS jsonb
      LANGUAGE sql
      STABLE
      SET search_path = pg_catalog
      AS $jwt$
        SELECT COALESCE(
          NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
          '{}'::jsonb
        );
      $jwt$;
    `);

    for (const file of migrationFiles) {
      const fullPath = path.resolve(process.cwd(), 'supabase/migrations', file);
      const sql = await fs.readFile(fullPath, 'utf8');
      await client.query(sql);
    }

    const policies = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_policies WHERE schemaname = 'public'",
    );
    assert.equal(Number(policies.rows[0]?.count), 46, 'Expected 46 tenant/security policies');

    const access = await client.query<{
      anon_orders: boolean;
      auth_orders: boolean;
      auth_users: boolean;
      anon_plans: boolean;
    }>(`
      SELECT
        has_table_privilege('anon', 'public.orders', 'SELECT') AS anon_orders,
        has_table_privilege('authenticated', 'public.orders', 'SELECT') AS auth_orders,
        has_table_privilege('authenticated', 'public.users', 'SELECT') AS auth_users,
        has_table_privilege('anon', 'public.plans', 'SELECT') AS anon_plans
    `);
    assert.equal(access.rows[0]?.anon_orders, false);
    assert.equal(access.rows[0]?.auth_orders, true);
    assert.equal(access.rows[0]?.auth_users, false);
    assert.equal(access.rows[0]?.anon_plans, true);

    const functions = await client.query<{ proconfig: string[] | null }>(`
      SELECT proconfig
      FROM pg_proc
      WHERE oid IN (
        'public.current_tenant_id()'::regprocedure,
        'public.is_superadmin()'::regprocedure
      )
    `);
    assert.equal(functions.rows.length, 2);
    for (const fn of functions.rows) {
      assert.ok(fn.proconfig?.includes('search_path=pg_catalog'));
    }

    process.stdout.write('Supabase SQL migrations: 46 RLS policies, grants and function search_path verified.\\n');
  } finally {
    await client.end();
  }
}

await main();
