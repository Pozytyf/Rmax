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
  '202611260015_index_operational_foreign_keys.sql',
  '202611260017_add_option_groups_json_to_menu_items.sql',
  '202611260018_add_public_order_fields.sql',
  '202611260019_add_public_restaurant_settings.sql',
  '202611260020_seed_default_saas_plans.sql',
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
      GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
      GRANT EXECUTE ON FUNCTION auth.jwt() TO anon, authenticated, service_role;
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

    // Exercise the actual RLS policy as the authenticated Data API role.
    await client.query('BEGIN');
    try {
      await client.query(`
        INSERT INTO public.restaurants (id, name, slug, email, created_at)
        VALUES
          ('rls_ci_rest_a', 'RLS CI A', 'rls-ci-a', 'rls-ci-a@example.invalid', '2026-11-26T00:00:00.000Z'),
          ('rls_ci_rest_b', 'RLS CI B', 'rls-ci-b', 'rls-ci-b@example.invalid', '2026-11-26T00:00:00.000Z')
      `);
      await client.query(`
        INSERT INTO public.orders (id, restaurant_id, order_number, order_type, subtotal_xof, total_xof, created_at, updated_at)
        VALUES
          ('rls_ci_order_a', 'rls_ci_rest_a', 'RLS-CI-A-001', 'DINE_IN', 100, 100, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z'),
          ('rls_ci_order_b', 'rls_ci_rest_b', 'RLS-CI-B-001', 'DINE_IN', 200, 200, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z')
      `);
      await client.query('SET LOCAL ROLE authenticated');
      await client.query(
        "SELECT set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ restaurant_id: 'rls_ci_rest_a' })],
      );

      const visibleOrders = await client.query<{ id: string; restaurant_id: string }>(
        'SELECT id, restaurant_id FROM public.orders ORDER BY id',
      );
      assert.deepEqual(visibleOrders.rows, [
        { id: 'rls_ci_order_a', restaurant_id: 'rls_ci_rest_a' },
      ]);

      const crossTenantUpdate = await client.query(
        "UPDATE public.orders SET total_xof = 999 WHERE restaurant_id = 'rls_ci_rest_b'",
      );
      assert.equal(crossTenantUpdate.rowCount, 0);

      await client.query('SAVEPOINT cross_tenant_insert');
      await assert.rejects(
        () => client.query(`
          INSERT INTO public.orders (id, restaurant_id, order_number, order_type, subtotal_xof, total_xof, created_at, updated_at)
          VALUES ('rls_ci_order_forbidden', 'rls_ci_rest_b', 'RLS-CI-FORBIDDEN', 'DINE_IN', 300, 300, '2026-11-26T00:00:00.000Z', '2026-11-26T00:00:00.000Z')
        `),
        (error: unknown) =>
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          (error as { code?: string }).code === '42501',
      );
      await client.query('ROLLBACK TO SAVEPOINT cross_tenant_insert');
    } finally {
      await client.query('ROLLBACK');
    }

    process.stdout.write('Supabase SQL migrations: 46 RLS policies, grants, function search_path and cross-tenant denial verified.\\n');
  } finally {
    await client.end();
  }
}

await main();
