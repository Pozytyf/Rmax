import type { Knex } from 'knex';

const columns: Array<{ name: string; add: (table: Knex.CreateTableBuilder) => void }> = [
  { name: 'customer_phone', add: (table) => table.string('customer_phone').nullable() },
  { name: 'delivery_address', add: (table) => table.text('delivery_address').nullable() },
  { name: 'delivery_zone', add: (table) => table.string('delivery_zone').nullable() },
  { name: 'delivery_fee_xof', add: (table) => table.integer('delivery_fee_xof').notNullable().defaultTo(0) },
  { name: 'scheduled_slot', add: (table) => table.string('scheduled_slot').nullable() },
  { name: 'promo_code', add: (table) => table.string('promo_code').nullable() },
  { name: 'loyalty_points_used', add: (table) => table.integer('loyalty_points_used').notNullable().defaultTo(0) },
  { name: 'loyalty_points_earned', add: (table) => table.integer('loyalty_points_earned').notNullable().defaultTo(0) },
];

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('orders'))) {
    throw new Error('La table orders doit exister avant les champs de commande publique.');
  }
  for (const column of columns) {
    if (!(await knex.schema.hasColumn('orders', column.name))) {
      await knex.schema.alterTable('orders', (table) => column.add(table));
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Deliberately retain these additive fields during rollback: they can contain
  // customer contact, delivery, promotion and loyalty history. Rolling back
  // application code is safe while retaining nullable/defaulted columns.
}
