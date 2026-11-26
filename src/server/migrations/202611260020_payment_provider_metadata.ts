import type { Knex } from 'knex';

const columns: Array<{ name: string; add: (table: Knex.CreateTableBuilder) => void }> = [
  { name: 'provider', add: (table) => table.string('provider') },
  { name: 'provider_reference', add: (table) => table.string('provider_reference') },
  { name: 'checkout_url', add: (table) => table.text('checkout_url') },
  { name: 'provider_status', add: (table) => table.string('provider_status') },
  { name: 'provider_payload_json', add: (table) => table.text('provider_payload_json') },
  { name: 'updated_at', add: (table) => table.string('updated_at') },
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('payments'))) {
    throw new Error('La table payments doit exister avant les métadonnées prestataire.');
  }
  for (const column of columns) {
    if (!(await knex.schema.hasColumn('payments', column.name))) {
      await knex.schema.alterTable('payments', (table) => column.add(table));
    }
  }
  const hasIndex = await knex.schema.hasColumn('payments', 'provider_reference');
  if (hasIndex) {
    await knex.raw(
      'CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_unique ON payments(provider, provider_reference) WHERE provider_reference IS NOT NULL',
    );
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Retain provider audit metadata during rollback; deleting it could erase
  // evidence needed to reconcile a payment with the provider.
}
