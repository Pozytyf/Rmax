import type { Knex } from 'knex';

/**
 * Aligne le schéma PostgreSQL sur les colonnes utilisées par les opérations
 * de stock : classification cuisine/boissons et catégorie des pertes.
 */
export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('stocks')) {
    if (!(await knex.schema.hasColumn('stocks', 'stock_section'))) {
      await knex.schema.alterTable('stocks', (table) => {
        table.string('stock_section').notNullable().defaultTo('KITCHEN');
      });
    }
  }
  if (await knex.schema.hasTable('stock_movements')) {
    if (!(await knex.schema.hasColumn('stock_movements', 'waste_category'))) {
      await knex.schema.alterTable('stock_movements', (table) => {
        table.string('waste_category').notNullable().defaultTo('');
      });
    }
  }
}

export async function down(_knex: Knex): Promise<void> {
  // Colonnes conservées pour ne pas perdre les métadonnées opérationnelles.
}
