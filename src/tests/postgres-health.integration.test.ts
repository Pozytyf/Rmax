import test from 'node:test';
import assert from 'node:assert/strict';
import { assertKnexMigrationsCurrent } from '../server/knex.ts';
import { checkSupabaseHealth } from '../server/lib/supabase.ts';

test('selected PostgreSQL pool is reachable and schema is fully migrated', async () => {
  const health = await checkSupabaseHealth();
  assert.equal(health.postgresConnected, true);
  assert.ok(typeof health.latencyMs === 'number');
  await assertKnexMigrationsCurrent();
});
