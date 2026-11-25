import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnexMigrationsCurrent, getKnex } from '../server/knex.ts';
import { checkSupabaseHealth } from '../server/lib/supabase.ts';

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
  }
});
