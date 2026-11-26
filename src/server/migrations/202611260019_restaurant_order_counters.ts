import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('restaurant_order_counters'))) {
    await knex.schema.createTable('restaurant_order_counters', (table) => {
      table.string('restaurant_id').primary();
      table.integer('last_number').notNullable().defaultTo(1000);
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.foreign('restaurant_id').references('restaurants.id').onDelete('CASCADE');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  // Do not drop this counter automatically: its value protects order-number
  // uniqueness. A rollback must not permit reuse of already-issued numbers.
}
