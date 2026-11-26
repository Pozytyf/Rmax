import type { Knex } from 'knex';

const columns: Array<{ name: string; add: (table: Knex.CreateTableBuilder) => void }> = [
  { name: 'loyalty_enabled', add: (table) => table.integer('loyalty_enabled').notNullable().defaultTo(1) },
  { name: 'loyalty_points_per_1000_xof', add: (table) => table.integer('loyalty_points_per_1000_xof').notNullable().defaultTo(10) },
  { name: 'loyalty_xof_per_point', add: (table) => table.integer('loyalty_xof_per_point').notNullable().defaultTo(25) },
  { name: 'storefront_enabled', add: (table) => table.integer('storefront_enabled').notNullable().defaultTo(1) },
  { name: 'delivery_enabled', add: (table) => table.integer('delivery_enabled').notNullable().defaultTo(1) },
  { name: 'delivery_zones_json', add: (table) => table.text('delivery_zones_json').notNullable().defaultTo('[]') },
  { name: 'pickup_slots_json', add: (table) => table.text('pickup_slots_json').notNullable().defaultTo('[]') },
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('restaurants'))) {
    throw new Error('La table restaurants doit exister avant les paramètres publics.');
  }
  for (const column of columns) {
    if (!(await knex.schema.hasColumn('restaurants', column.name))) {
      await knex.schema.alterTable('restaurants', (table) => column.add(table));
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Keep additive tenant settings on rollback to avoid losing storefront and
  // loyalty configuration entered by restaurants.
}
