import type { Knex } from 'knex';

/**
 * Restore referential integrity for the business schema. Constraints are added
 * NOT VALID first to avoid a full table scan while holding the initial DDL
 * lock, then validated explicitly. Existing orphaned rows fail the migration
 * instead of being silently discarded.
 */
const foreignKeys: Array<{
  table: string;
  name: string;
  column: string;
  target: string;
  targetColumn?: string;
  onDelete?: string;
}> = [
  { table: 'restaurant_members', name: 'fk_restaurant_members_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'restaurant_members', name: 'fk_restaurant_members_user', column: 'user_id', target: 'users', onDelete: 'CASCADE' },
  { table: 'sessions', name: 'fk_sessions_user', column: 'user_id', target: 'users', onDelete: 'CASCADE' },
  { table: 'sessions', name: 'fk_sessions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'SET NULL' },
  { table: 'subscriptions', name: 'fk_subscriptions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'subscriptions', name: 'fk_subscriptions_plan', column: 'plan_id', target: 'plans' },
  { table: 'platform_invoices', name: 'fk_platform_invoices_restaurant', column: 'restaurant_id', target: 'restaurants' },
  { table: 'platform_invoices', name: 'fk_platform_invoices_subscription', column: 'subscription_id', target: 'subscriptions', onDelete: 'SET NULL' },
  { table: 'menu_categories', name: 'fk_menu_categories_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'menu_items', name: 'fk_menu_items_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'menu_items', name: 'fk_menu_items_category', column: 'category_id', target: 'menu_categories' },
  { table: 'dining_tables', name: 'fk_dining_tables_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'qr_codes', name: 'fk_qr_codes_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'qr_codes', name: 'fk_qr_codes_table', column: 'table_id', target: 'dining_tables', onDelete: 'CASCADE' },
  { table: 'qr_table_sessions', name: 'fk_qr_table_sessions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'qr_table_sessions', name: 'fk_qr_table_sessions_table', column: 'table_id', target: 'dining_tables', onDelete: 'CASCADE' },
  { table: 'orders', name: 'fk_orders_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'orders', name: 'fk_orders_table', column: 'table_id', target: 'dining_tables', onDelete: 'SET NULL' },
  { table: 'order_items', name: 'fk_order_items_order', column: 'order_id', target: 'orders', onDelete: 'CASCADE' },
  { table: 'order_items', name: 'fk_order_items_menu_item', column: 'menu_item_id', target: 'menu_items' },
  { table: 'payments', name: 'fk_payments_restaurant', column: 'restaurant_id', target: 'restaurants' },
  { table: 'payments', name: 'fk_payments_order', column: 'order_id', target: 'orders' },
  { table: 'stocks', name: 'fk_stocks_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'stock_movements', name: 'fk_stock_movements_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'stock_movements', name: 'fk_stock_movements_stock', column: 'stock_id', target: 'stocks', onDelete: 'CASCADE' },
  { table: 'menu_item_recipes', name: 'fk_menu_item_recipes_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'menu_item_recipes', name: 'fk_menu_item_recipes_menu_item', column: 'menu_item_id', target: 'menu_items', onDelete: 'CASCADE' },
  { table: 'menu_item_recipes', name: 'fk_menu_item_recipes_stock', column: 'stock_id', target: 'stocks' },
  { table: 'stock_alert_settings', name: 'fk_stock_alert_settings_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'notifications', name: 'fk_notifications_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'notifications', name: 'fk_notifications_stock', column: 'stock_id', target: 'stocks', onDelete: 'SET NULL' },
  { table: 'customers', name: 'fk_customers_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'reservations', name: 'fk_reservations_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'reservations', name: 'fk_reservations_table', column: 'table_id', target: 'dining_tables', onDelete: 'SET NULL' },
  { table: 'expenses', name: 'fk_expenses_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'support_tickets', name: 'fk_support_tickets_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'SET NULL' },
  { table: 'ticket_messages', name: 'fk_ticket_messages_ticket', column: 'ticket_id', target: 'support_tickets', onDelete: 'CASCADE' },
  { table: 'audit_logs', name: 'fk_audit_logs_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'SET NULL' },
  { table: 'purchase_orders', name: 'fk_purchase_orders_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'purchase_order_items', name: 'fk_purchase_order_items_order', column: 'purchase_order_id', target: 'purchase_orders', onDelete: 'CASCADE' },
  { table: 'purchase_order_items', name: 'fk_purchase_order_items_stock', column: 'stock_id', target: 'stocks' },
  { table: 'whatsapp_logs', name: 'fk_whatsapp_logs_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'menu_combos', name: 'fk_menu_combos_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'promotions', name: 'fk_promotions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'promotions', name: 'fk_promotions_category', column: 'category_id', target: 'menu_categories', onDelete: 'SET NULL' },
  { table: 'cash_register_sessions', name: 'fk_cash_register_sessions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'cash_register_sessions', name: 'fk_cash_register_sessions_opened_by', column: 'opened_by_user_id', target: 'users', onDelete: 'SET NULL' },
  { table: 'cash_register_sessions', name: 'fk_cash_register_sessions_closed_by', column: 'closed_by_user_id', target: 'users', onDelete: 'SET NULL' },
  { table: 'table_calls', name: 'fk_table_calls_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'table_calls', name: 'fk_table_calls_table', column: 'table_id', target: 'dining_tables', onDelete: 'CASCADE' },
  { table: 'loyalty_transactions', name: 'fk_loyalty_transactions_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'loyalty_transactions', name: 'fk_loyalty_transactions_customer', column: 'customer_id', target: 'customers', onDelete: 'CASCADE' },
  { table: 'loyalty_transactions', name: 'fk_loyalty_transactions_order', column: 'order_id', target: 'orders', onDelete: 'SET NULL' },
  { table: 'customer_reviews', name: 'fk_customer_reviews_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'customer_reviews', name: 'fk_customer_reviews_order', column: 'order_id', target: 'orders', onDelete: 'CASCADE' },
  { table: 'inventory_counts', name: 'fk_inventory_counts_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'inventory_count_lines', name: 'fk_inventory_count_lines_count', column: 'inventory_count_id', target: 'inventory_counts', onDelete: 'CASCADE' },
  { table: 'inventory_count_lines', name: 'fk_inventory_count_lines_stock', column: 'stock_id', target: 'stocks' },
  { table: 'staff_shifts', name: 'fk_staff_shifts_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'staff_shifts', name: 'fk_staff_shifts_user', column: 'user_id', target: 'users', onDelete: 'CASCADE' },
  { table: 'staff_time_clocks', name: 'fk_staff_time_clocks_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
  { table: 'staff_time_clocks', name: 'fk_staff_time_clocks_user', column: 'user_id', target: 'users', onDelete: 'CASCADE' },
  { table: 'b2b_invoices', name: 'fk_b2b_invoices_restaurant', column: 'restaurant_id', target: 'restaurants', onDelete: 'CASCADE' },
];

export async function up(knex: Knex): Promise<void> {
  if (knex.client.config.client !== 'pg') return;

  for (const fk of foreignKeys) {
    const tableExists = await knex.schema.hasTable(fk.table);
    const targetExists = await knex.schema.hasTable(fk.target);
    if (!tableExists || !targetExists) {
      throw new Error(`Cannot add ${fk.name}: source or target table is missing.`);
    }

    const hasColumn = await knex.schema.hasColumn(fk.table, fk.column);
    const hasTargetColumn = await knex.schema.hasColumn(fk.target, fk.targetColumn || 'id');
    if (!hasColumn || !hasTargetColumn) {
      throw new Error(`Cannot add ${fk.name}: source or target column is missing.`);
    }

    const existing = await knex.raw(
      `SELECT 1
       FROM pg_constraint c
       JOIN pg_class target_table ON target_table.oid = c.confrelid
       JOIN pg_attribute source_column
         ON source_column.attrelid = c.conrelid
        AND source_column.attnum = ANY(c.conkey)
       WHERE c.contype = 'f'
         AND c.conrelid = ?::regclass
         AND source_column.attname = ?
         AND target_table.relname = ?
       LIMIT 1`,
      [fk.table, fk.column, fk.target],
    );
    // Several operation tables already declare these FKs in migration 007.
    // Skip equivalent constraints rather than installing duplicates.
    if (existing.rows.length > 0) continue;

    const deleteClause = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
    await knex.raw(
      `ALTER TABLE ?? ADD CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ?? (??)${deleteClause} NOT VALID`,
      [fk.table, fk.name, fk.column, fk.target, fk.targetColumn || 'id'],
    );
    await knex.raw('ALTER TABLE ?? VALIDATE CONSTRAINT ??', [fk.table, fk.name]);
  }
}

export async function down(knex: Knex): Promise<void> {
  if (knex.client.config.client !== 'pg') return;

  for (const fk of [...foreignKeys].reverse()) {
    const tableExists = await knex.schema.hasTable(fk.table);
    if (!tableExists) continue;
    const existing = await knex.raw(
      'SELECT 1 FROM pg_constraint WHERE conname = ? AND conrelid = ?::regclass LIMIT 1',
      [fk.name, fk.table],
    );
    if (existing.rows.length === 0) continue;
    await knex.raw('ALTER TABLE ?? DROP CONSTRAINT ??', [fk.table, fk.name]);
  }
}
