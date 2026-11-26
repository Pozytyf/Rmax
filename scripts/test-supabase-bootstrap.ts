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

    const requiredTables = [
      'restaurants',
      'tenants',
      'users',
      'sessions',
      'auth_tokens',
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
    ];
    for (const table of requiredTables) {
      const result = await client.query(
        'SELECT to_regclass($1) IS NOT NULL AS exists',
        [`public.${table}`],
      );
      assert.equal(result.rows[0]?.exists, true, `Bootstrap schema is missing ${table}`);
    }

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

    process.stdout.write('Supabase bootstrap schema: tables, 46 RLS policies and grants verified.\\n');
  } finally {
    await client.end();
  }
}

await main();
