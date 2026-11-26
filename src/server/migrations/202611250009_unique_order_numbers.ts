import type { Knex } from 'knex';

const indexName = 'uq_orders_restaurant_order_number';

export async function up(knex: Knex): Promise<void> {
  const duplicateRows = await knex('orders')
    .select('restaurant_id', 'order_number')
    .count<{ count: string }[]>({ count: '*' })
    .groupBy('restaurant_id', 'order_number')
    .havingRaw('COUNT(*) > 1')
    .limit(10);

  if (duplicateRows.length > 0) {
    throw new Error(
      `Cannot enforce unique order numbers: duplicates found: ${JSON.stringify(duplicateRows)}`,
    );
  }

  await knex.raw(
    'CREATE UNIQUE INDEX IF NOT EXISTS ?? ON ?? (??, ??)',
    [indexName, 'orders', 'restaurant_id', 'order_number'],
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS ??', [indexName]);
}
