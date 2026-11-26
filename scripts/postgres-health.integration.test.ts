import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnexMigrationsCurrent, getKnex } from '../src/server/knex.ts';
import { checkSupabaseHealth } from '../src/server/lib/supabase.ts';

test('selected PostgreSQL pool is reachable and schema is fully migrated', async () => {
  const health = await checkSupabaseHealth();
  assert.equal(health.postgresConnected, true);
  assert.ok(typeof health.latencyMs === 'number');
  await assertKnexMigrationsCurrent();

  const db = getKnex();
  const requiredOperationsTables = [
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
  for (const table of requiredOperationsTables) {
    assert.equal(await db.schema.hasTable(table), true, `Missing PostgreSQL table: ${table}`);
    const rls = await db.raw(
      'SELECT relrowsecurity FROM pg_class WHERE oid = ?::regclass',
      [table],
    );
    assert.equal(rls.rows[0]?.relrowsecurity, true, `RLS is disabled on ${table}`);
  }

  const requiredForeignKeys = [
    ['restaurant_members', 'restaurant_id', 'restaurants'],
    ['restaurant_members', 'user_id', 'users'],
    ['orders', 'restaurant_id', 'restaurants'],
    ['order_items', 'order_id', 'orders'],
    ['order_items', 'menu_item_id', 'menu_items'],
    ['payments', 'order_id', 'orders'],
    ['stock_movements', 'stock_id', 'stocks'],
    ['menu_item_recipes', 'menu_item_id', 'menu_items'],
    ['menu_item_recipes', 'stock_id', 'stocks'],
    ['loyalty_transactions', 'customer_id', 'customers'],
    ['inventory_count_lines', 'inventory_count_id', 'inventory_counts'],
  ] as const;

  for (const [table, column, target] of requiredForeignKeys) {
    const fk = await db.raw(
      `SELECT 1
       FROM pg_constraint c
       JOIN pg_class target_table ON target_table.oid = c.confrelid
       JOIN pg_attribute source_column
         ON source_column.attrelid = c.conrelid
        AND source_column.attnum = ANY(c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = ?::regclass
         AND source_column.attname = ?
         AND target_table.relname = ?
       LIMIT 1`,
      [table, column, target],
    );
    assert.equal(fk.rows.length, 1, `Missing foreign key ${table}.${column} -> ${target}`);
  }
});
