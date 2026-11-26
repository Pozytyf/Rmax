import type { Knex } from 'knex';

/**
 * Tables used by the existing operations repositories but missing from the
 * original Knex/PostgreSQL schema. Keep SQLite-compatible integer flags and
 * string ISO dates so repository semantics remain stable across engines.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('menu_combos'))) {
    await knex.schema.createTable('menu_combos', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('name').notNullable();
      t.text('description').notNullable().defaultTo('');
      t.integer('price_xof').notNullable();
      t.text('image_url');
      t.integer('is_daily_special').notNullable().defaultTo(0);
      t.text('items_json').notNullable().defaultTo('[]');
      t.integer('active').notNullable().defaultTo(1);
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'active'], 'idx_menu_combos_restaurant_active');
    });
  }

  if (!(await knex.schema.hasTable('promotions'))) {
    await knex.schema.createTable('promotions', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('name').notNullable();
      t.string('code');
      t.string('promo_type').notNullable().defaultTo('PROMO_CODE');
      t.string('discount_type').notNullable().defaultTo('PERCENT');
      t.integer('discount_value').notNullable().defaultTo(10);
      t.integer('min_order_xof').notNullable().defaultTo(0);
      t.text('days_json').notNullable().defaultTo('[0,1,2,3,4,5,6]');
      t.string('start_time').notNullable().defaultTo('17:00');
      t.string('end_time').notNullable().defaultTo('20:00');
      t.string('category_id');
      t.integer('max_uses');
      t.integer('uses_count').notNullable().defaultTo(0);
      t.integer('active').notNullable().defaultTo(1);
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'active'], 'idx_promotions_restaurant_active');
    });
  }

  if (!(await knex.schema.hasTable('cash_register_sessions'))) {
    await knex.schema.createTable('cash_register_sessions', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('z_number').notNullable().defaultTo('');
      t.string('opened_by_user_id').references('id').inTable('users').onDelete('SET NULL');
      t.string('opened_by_name').notNullable();
      t.integer('opening_float_xof').notNullable().defaultTo(0);
      t.string('opened_at').notNullable();
      t.string('closed_by_user_id').references('id').inTable('users').onDelete('SET NULL');
      t.string('closed_by_name');
      t.string('closed_at');
      t.string('status').notNullable().defaultTo('OPEN');
      t.integer('expected_cash_xof').notNullable().defaultTo(0);
      t.integer('expected_mobile_xof').notNullable().defaultTo(0);
      t.integer('expected_card_xof').notNullable().defaultTo(0);
      t.integer('counted_cash_xof').notNullable().defaultTo(0);
      t.integer('counted_mobile_xof').notNullable().defaultTo(0);
      t.integer('counted_card_xof').notNullable().defaultTo(0);
      t.integer('variance_xof').notNullable().defaultTo(0);
      t.integer('total_sales_xof').notNullable().defaultTo(0);
      t.integer('refunds_xof').notNullable().defaultTo(0);
      t.integer('orders_count').notNullable().defaultTo(0);
      t.text('notes').notNullable().defaultTo('');
      t.index(['restaurant_id', 'status', 'opened_at'], 'idx_cash_register_restaurant_status');
    });
  }

  if (!(await knex.schema.hasTable('table_calls'))) {
    await knex.schema.createTable('table_calls', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('table_id').notNullable().references('id').inTable('dining_tables').onDelete('CASCADE');
      t.string('table_label').notNullable();
      t.string('call_type').notNullable().defaultTo('WAITER');
      t.text('note').notNullable().defaultTo('');
      t.string('status').notNullable().defaultTo('PENDING');
      t.string('acknowledged_by_name');
      t.string('acknowledged_at');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'status', 'created_at'], 'idx_table_calls_restaurant_status');
    });
  }

  if (!(await knex.schema.hasTable('loyalty_transactions'))) {
    await knex.schema.createTable('loyalty_transactions', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
      t.string('order_id').references('id').inTable('orders').onDelete('SET NULL');
      t.integer('points_delta').notNullable();
      t.text('reason').notNullable().defaultTo('');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'customer_id', 'created_at'], 'idx_loyalty_transactions_customer');
    });
  }

  if (!(await knex.schema.hasTable('customer_reviews'))) {
    await knex.schema.createTable('customer_reviews', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('order_id').unique().references('id').inTable('orders').onDelete('CASCADE');
      t.string('order_number').notNullable().defaultTo('');
      t.string('table_label').notNullable().defaultTo('');
      t.string('customer_name').notNullable().defaultTo('Client');
      t.integer('rating').notNullable();
      t.integer('service_rating').notNullable().defaultTo(5);
      t.integer('food_rating').notNullable().defaultTo(5);
      t.integer('speed_rating').notNullable().defaultTo(5);
      t.string('waiter_name').notNullable().defaultTo('');
      t.string('channel').notNullable().defaultTo('QR_ORDER');
      t.text('comment').notNullable().defaultTo('');
      t.text('reply').notNullable().defaultTo('');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'created_at'], 'idx_customer_reviews_restaurant_created');
    });
  }

  if (!(await knex.schema.hasTable('inventory_counts'))) {
    await knex.schema.createTable('inventory_counts', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('title').notNullable();
      t.string('stock_section').notNullable().defaultTo('ALL');
      t.string('status').notNullable().defaultTo('VALIDATED');
      t.text('notes').notNullable().defaultTo('');
      t.integer('total_variance_xof').notNullable().defaultTo(0);
      t.string('created_by_name').notNullable().defaultTo('');
      t.string('validated_at');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'created_at'], 'idx_inventory_counts_restaurant_created');
    });
  }

  if (!(await knex.schema.hasTable('inventory_count_lines'))) {
    await knex.schema.createTable('inventory_count_lines', (t) => {
      t.string('id').primary();
      t.string('inventory_count_id').notNullable().references('id').inTable('inventory_counts').onDelete('CASCADE');
      t.string('stock_id').notNullable().references('id').inTable('stocks').onDelete('CASCADE');
      t.string('stock_name').notNullable();
      t.string('unit').notNullable().defaultTo('kg');
      t.float('expected_qty').notNullable();
      t.float('counted_qty').notNullable();
      t.float('variance_qty').notNullable();
      t.integer('unit_cost_xof').notNullable().defaultTo(0);
      t.integer('variance_xof').notNullable().defaultTo(0);
      t.index(['inventory_count_id'], 'idx_inventory_count_lines_count');
      t.index(['stock_id'], 'idx_inventory_count_lines_stock');
    });
  }

  if (!(await knex.schema.hasTable('staff_shifts'))) {
    await knex.schema.createTable('staff_shifts', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('staff_name').notNullable();
      t.string('role').notNullable();
      t.string('shift_date').notNullable();
      t.string('start_time').notNullable();
      t.string('end_time').notNullable();
      t.text('notes').notNullable().defaultTo('');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'shift_date'], 'idx_staff_shifts_restaurant_date');
      t.index(['user_id', 'shift_date'], 'idx_staff_shifts_user_date');
    });
  }

  if (!(await knex.schema.hasTable('staff_time_clocks'))) {
    await knex.schema.createTable('staff_time_clocks', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('staff_name').notNullable();
      t.string('role').notNullable();
      t.string('clock_in_at').notNullable();
      t.string('clock_out_at');
      t.integer('duration_minutes').notNullable().defaultTo(0);
      t.text('notes').notNullable().defaultTo('');
      t.index(['restaurant_id', 'clock_in_at'], 'idx_staff_time_clocks_restaurant_in');
      t.index(['user_id', 'clock_in_at'], 'idx_staff_time_clocks_user_in');
    });
  }

  if (!(await knex.schema.hasTable('b2b_invoices'))) {
    await knex.schema.createTable('b2b_invoices', (t) => {
      t.string('id').primary();
      t.string('restaurant_id').notNullable().references('id').inTable('restaurants').onDelete('CASCADE');
      t.string('invoice_number').notNullable().unique();
      t.string('doc_type').notNullable().defaultTo('PROFORMA');
      t.string('client_name').notNullable();
      t.string('client_company').notNullable().defaultTo('');
      t.string('client_tax_id').notNullable().defaultTo('');
      t.string('client_email').notNullable().defaultTo('');
      t.string('client_phone').notNullable().defaultTo('');
      t.text('client_address').notNullable().defaultTo('');
      t.text('items_json').notNullable().defaultTo('[]');
      t.integer('subtotal_ht_xof').notNullable().defaultTo(0);
      t.float('tax_rate_percent').notNullable().defaultTo(18);
      t.integer('tax_xof').notNullable().defaultTo(0);
      t.integer('total_ttc_xof').notNullable().defaultTo(0);
      t.string('status').notNullable().defaultTo('DRAFT');
      t.string('due_date');
      t.text('notes').notNullable().defaultTo('');
      t.string('created_at').notNullable();
      t.index(['restaurant_id', 'created_at'], 'idx_b2b_invoices_restaurant_created');
    });
  }

  // Explicitly enable RLS on every newly introduced tenant-owned table.
  // No permissive client policies are created until the browser has a trusted
  // Supabase JWT carrying the authenticated restaurant claim.
  if (knex.client.config.client === 'pg') {
    for (const table of [
      'menu_combos',
      'promotions',
      'cash_register_sessions',
      'table_calls',
      'loyalty_transactions',
      'customer_reviews',
      'inventory_counts',
      'inventory_count_lines',
      'staff_shifts',
      'staff_time_clocks',
      'b2b_invoices',
    ]) {
      await knex.raw('ALTER TABLE ?? ENABLE ROW LEVEL SECURITY', [table]);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  const tables = [
    'b2b_invoices',
    'staff_time_clocks',
    'staff_shifts',
    'inventory_count_lines',
    'inventory_counts',
    'customer_reviews',
    'loyalty_transactions',
    'table_calls',
    'cash_register_sessions',
    'promotions',
    'menu_combos',
  ];

  for (const table of tables) {
    await knex.schema.dropTableIfExists(table);
  }
}
