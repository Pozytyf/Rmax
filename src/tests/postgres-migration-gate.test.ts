import test from 'node:test';
import assert from 'node:assert/strict';
import knex from 'knex';
import { assertKnexMigrationsCurrent } from '../server/knex.ts';

test('production migration check rejects pending schema changes without applying them', async () => {
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: {
      directory: new URL('../server/migrations', import.meta.url).pathname,
      extension: 'ts',
    },
  });

  try {
    await assert.rejects(
      () => assertKnexMigrationsCurrent(db),
      /Migrations PostgreSQL manquantes/,
    );
    const [completed, pending] = await db.migrate.list();
    assert.equal(completed.length, 0);
    assert.ok(pending.length > 0);

    await db.migrate.latest();
    await assertKnexMigrationsCurrent(db);
  } finally {
    await db.destroy();
  }
});
