import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required to validate the Supabase bootstrap schema.');
}

const client = new Client({
  connectionString,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
});

async function main(): Promise<void> {
  await client.connect();
  try {
    await client.query(`
      DO $roles$
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
      $roles$;
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

    const schemaPath = path.resolve(process.cwd(), 'supabase/schema.sql');
    const schemaSql = await fs.readFile(schemaPath, 'utf8');
    await client.query(schemaSql);

    // Validate the complete bootstrap path: base schema plus the same
    // operational/RLS migrations applied to an existing Supabase project.
    for (const migration of [
      '202611260010_revoke_public_rls_trigger_execute.sql',
      '202611260011_add_operations_schema_and_rls.sql',
      '202611260012_pin_tenant_function_search_path.sql',
      '202611260013_apply_existing_tenant_rls.sql',
      '202611260014_deny_api_access_to_internal_tables.sql',
      '202611260015_index_operational_foreign_keys.sql',
      '202611260017_add_option_groups_json_to_menu_items.sql',
      '202611260018_add_public_order_fields.sql',
    ]) {
      const migrationPath = path.resolve(process.cwd(), 'supabase/migrations', migration);
      await client.query(await fs.readFile(migrationPath, 'utf8'));
    }

    const requiredTables = [
      'restaurants',
      'tenants',
      'users',
      'sessions',
      'auth_tokens',
      'roles',
      'orders',
      'order_items',
      'payments',
      'stocks',
      'menu_combos',
      'promotions',
      'cash_register_sessions',
      'table_calls',
      'loyalty_transactions',
      'customer_reviews',
      'inventory_counts',
      'inventory_count_lines',
      'staff_shifts',
      'staff_time_clocks',
      'b2b_invoices',
      'purchase_orders',
      'purchase_order_items',
      'whatsapp_logs',
    ];
    for (const table of requiredTables) {
      const result = await client.query(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [`public.${table}`],
      );
      assert.equal(result.rows[0]?.exists, true, `Bootstrap schema is missing ${table}`);
    }

    const optionGroupsColumn = await client.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'menu_items' AND column_name = 'option_groups_json') AS exists",
    );
    assert.equal(optionGroupsColumn.rows[0]?.exists, true, 'Bootstrap schema is missing menu_items.option_groups_json');

    const publicOrderColumns = await client.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'orders' AND column_name IN ('customer_phone', 'delivery_address', 'delivery_zone', 'delivery_fee_xof', 'scheduled_slot', 'promo_code', 'loyalty_points_used', 'loyalty_points_earned')",
    );
    assert.equal(publicOrderColumns.rowCount, 8, 'Bootstrap schema is missing public order fields');

    const policies = await client.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM pg_policies WHERE schemaname = 'public'",
    );
    assert.equal(Number(policies.rows[0]?.count), 46, 'Expected 46 bootstrap RLS policies');

    const grants = await client.query<{
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
    assert.equal(grants.rows[0]?.anon_orders, false);
    assert.equal(grants.rows[0]?.auth_orders, true);
    assert.equal(grants.rows[0]?.auth_users, false);
    assert.equal(grants.rows[0]?.anon_plans, true);

    process.stdout.write('Supabase bootstrap schema and migrations: tables, 46 RLS policies and grants verified.\\n');
  } finally {
    await client.end();
  }
}

await main();
