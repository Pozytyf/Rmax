import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('menu_items'))) {
    throw new Error('La table menu_items doit exister avant l’ajout des groupes d’options.');
  }
  if (!(await knex.schema.hasColumn('menu_items', 'option_groups_json'))) {
    await knex.schema.alterTable('menu_items', (table) => {
      table.text('option_groups_json').notNullable().defaultTo('[]');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasColumn('menu_items', 'option_groups_json')) {
    await knex.schema.alterTable('menu_items', (table) => {
      table.dropColumn('option_groups_json');
    });
  }
}
