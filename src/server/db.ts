import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as SqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

let singletonDb: SqliteDatabase | null = null;

function assertSqliteRuntimeAllowed(): void {
  const client = (process.env.DATABASE_CLIENT || '').toLowerCase();
  const postgresRequested = ['pg', 'postgres', 'postgresql'].includes(client);
  const productionRuntime = process.env.NODE_ENV === 'production';

  if (postgresRequested || productionRuntime) {
    throw new Error(
      'Accès SQLite refusé : cette instance est configurée pour PostgreSQL ou Vercel production. Les repositories métier doivent être migrés vers PostgreSQL avant activation de ce runtime.',
    );
  }
}

export function getDb(customPath?: string): SqliteDatabase {
  assertSqliteRuntimeAllowed();

  if (singletonDb && !customPath) {
    return singletonDb;
  }

  const dbPath =
    customPath ||
    process.env.DATABASE_PATH ||
    (process.env.VERCEL
      ? '/tmp/restomax.db'
      : path.resolve(process.cwd(), 'data/restomax.db'));

  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  if (dbPath !== ':memory:') {
    db.pragma('journal_mode = WAL');
  }

  runMigrations(db);
  seedDatabaseIfEmpty(db);

  if (!customPath) {
    singletonDb = db;
  }
  return db;
}

export function setTestDb(db: SqliteDatabase): void {
  singletonDb = db;
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`;
}

function runMigrations(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      tagline TEXT NOT NULL,
      price_monthly_xof INTEGER NOT NULL,
      price_yearly_xof INTEGER NOT NULL,
      trial_days INTEGER NOT NULL DEFAULT 14,
      max_tables INTEGER NOT NULL,
      max_staff INTEGER NOT NULL,
      max_menu_items INTEGER NOT NULL,
      is_demo_pricing INTEGER NOT NULL DEFAULT 1,
      is_featured INTEGER NOT NULL DEFAULT 0,
      features_json TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tenants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT 'Abidjan',
      country TEXT NOT NULL DEFAULT 'Côte d''Ivoire',
      currency TEXT NOT NULL DEFAULT 'XOF',
      timezone TEXT NOT NULL DEFAULT 'Africa/Abidjan',
      tax_rate_percent REAL NOT NULL DEFAULT 18.0,
      service_fee_percent REAL NOT NULL DEFAULT 0.0,
      opening_hours TEXT NOT NULL DEFAULT '08:00 - 23:30',
      paydunya_mode TEXT NOT NULL DEFAULT 'TEST',
      paydunya_public_key TEXT NOT NULL DEFAULT '',
      paydunya_private_key TEXT NOT NULL DEFAULT '',
      paydunya_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'TRIAL',
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS restaurants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT 'Abidjan',
      country TEXT NOT NULL DEFAULT 'Côte d''Ivoire',
      currency TEXT NOT NULL DEFAULT 'XOF',
      timezone TEXT NOT NULL DEFAULT 'Africa/Abidjan',
      tax_rate_percent REAL NOT NULL DEFAULT 18.0,
      service_fee_percent REAL NOT NULL DEFAULT 0.0,
      opening_hours TEXT NOT NULL DEFAULT '08:00 - 23:30',
      paydunya_mode TEXT NOT NULL DEFAULT 'TEST',
      paydunya_public_key TEXT NOT NULL DEFAULT '',
      paydunya_private_key TEXT NOT NULL DEFAULT '',
      paydunya_token TEXT NOT NULL DEFAULT '',
      whatsapp_enabled INTEGER NOT NULL DEFAULT 0,
      whatsapp_phone_number_id TEXT NOT NULL DEFAULT '',
      whatsapp_access_token TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'TRIAL',
      deleted_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL DEFAULT 'OWNER',
      global_role TEXT NOT NULL DEFAULT 'USER',
      permissions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      email_verified INTEGER NOT NULL DEFAULT 0,
      email_verified_at TEXT,
      pin_hash TEXT,
      token_version INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS auth_tokens (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      token_type TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS restaurant_members (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      custom_permissions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      UNIQUE(restaurant_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      user_agent TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      plan_id TEXT NOT NULL REFERENCES plans(id),
      billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY',
      status TEXT NOT NULL DEFAULT 'TRIAL',
      trial_ends_at TEXT,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS platform_invoices (
      id TEXT PRIMARY KEY,
      invoice_number TEXT UNIQUE NOT NULL,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id),
      subscription_id TEXT REFERENCES subscriptions(id),
      amount_xof INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PAID',
      payment_method TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'TEST',
      paid_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS menu_categories (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      station TEXT NOT NULL DEFAULT 'KITCHEN',
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS menu_items (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      category_id TEXT NOT NULL REFERENCES menu_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_xof INTEGER NOT NULL,
      cost_price_xof INTEGER NOT NULL DEFAULT 0,
      image_url TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      options_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS dining_tables (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      zone TEXT NOT NULL DEFAULT 'Salle principale',
      label TEXT NOT NULL,
      capacity INTEGER NOT NULL DEFAULT 4,
      status TEXT NOT NULL DEFAULT 'AVAILABLE',
      pos_x INTEGER NOT NULL DEFAULT 40,
      pos_y INTEGER NOT NULL DEFAULT 40,
      shape TEXT NOT NULL DEFAULT 'ROUND'
    );

    CREATE TABLE IF NOT EXISTS qr_codes (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS qr_table_sessions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      qr_token TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      order_number TEXT NOT NULL,
      order_type TEXT NOT NULL,
      table_id TEXT REFERENCES dining_tables(id),
      customer_name TEXT NOT NULL DEFAULT 'Client comptoir',
      customer_phone TEXT,
      delivery_address TEXT,
      delivery_zone TEXT,
      delivery_fee_xof INTEGER NOT NULL DEFAULT 0,
      scheduled_slot TEXT,
      promo_code TEXT,
      loyalty_points_used INTEGER NOT NULL DEFAULT 0,
      loyalty_points_earned INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'PENDING',
      subtotal_xof INTEGER NOT NULL,
      discount_xof INTEGER NOT NULL DEFAULT 0,
      tax_xof INTEGER NOT NULL DEFAULT 0,
      total_xof INTEGER NOT NULL,
      paid_xof INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT,
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(restaurant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      menu_item_id TEXT NOT NULL REFERENCES menu_items(id),
      name TEXT NOT NULL,
      station TEXT NOT NULL,
      unit_price_xof INTEGER NOT NULL,
      options_summary TEXT NOT NULL DEFAULT '',
      options_delta_xof INTEGER NOT NULL DEFAULT 0,
      quantity INTEGER NOT NULL,
      line_total_xof INTEGER NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      prep_status TEXT NOT NULL DEFAULT 'PENDING'
    );

    CREATE TABLE IF NOT EXISTS payments (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      amount_xof INTEGER NOT NULL,
      method TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PAID',
      mode TEXT NOT NULL DEFAULT 'TEST',
      reference TEXT NOT NULL,
      idempotency_key TEXT,
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      UNIQUE(restaurant_id, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS stocks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      stock_section TEXT NOT NULL DEFAULT 'KITCHEN',
      quantity REAL NOT NULL DEFAULT 0,
      min_threshold REAL NOT NULL DEFAULT 5,
      unit_cost_xof INTEGER NOT NULL DEFAULT 0,
      supplier_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      stock_id TEXT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      movement_type TEXT NOT NULL,
      quantity_delta REAL NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS menu_item_recipes (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      menu_item_id TEXT NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
      stock_id TEXT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      quantity_per_unit REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(menu_item_id, stock_id)
    );

    CREATE TABLE IF NOT EXISTS stock_alert_settings (
      restaurant_id TEXT PRIMARY KEY REFERENCES restaurants(id) ON DELETE CASCADE,
      in_app_enabled INTEGER NOT NULL DEFAULT 1,
      email_enabled INTEGER NOT NULL DEFAULT 1,
      recipient_emails TEXT NOT NULL DEFAULT '',
      smtp_host TEXT NOT NULL DEFAULT '',
      smtp_port INTEGER NOT NULL DEFAULT 587,
      smtp_secure INTEGER NOT NULL DEFAULT 0,
      smtp_user TEXT NOT NULL DEFAULT '',
      smtp_pass TEXT NOT NULL DEFAULT '',
      smtp_from TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      stock_id TEXT REFERENCES stocks(id) ON DELETE SET NULL,
      email_dispatched INTEGER NOT NULL DEFAULT 0,
      email_recipients TEXT NOT NULL DEFAULT '',
      email_status TEXT NOT NULL DEFAULT 'SKIPPED',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT NOT NULL DEFAULT '',
      loyalty_points INTEGER NOT NULL DEFAULT 0,
      total_spent_xof INTEGER NOT NULL DEFAULT 0,
      visits_count INTEGER NOT NULL DEFAULT 0,
      preferences TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      party_size INTEGER NOT NULL DEFAULT 2,
      reserved_at TEXT NOT NULL,
      table_id TEXT REFERENCES dining_tables(id),
      status TEXT NOT NULL DEFAULT 'CONFIRMED',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount_xof INTEGER NOT NULL,
      expense_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT REFERENCES restaurants(id) ON DELETE SET NULL,
      created_by_email TEXT NOT NULL,
      subject TEXT NOT NULL,
      category TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'MEDIUM',
      status TEXT NOT NULL DEFAULT 'OPEN',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ticket_messages (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      role TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      restaurant_id TEXT,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contact_leads (
      id TEXT PRIMARY KEY,
      lead_type TEXT NOT NULL,
      full_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      restaurant_name TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'NEW',
      admin_notes TEXT NOT NULL DEFAULT '',
      converted_restaurant_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      po_number TEXT NOT NULL,
      supplier_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      total_cost_xof INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT '',
      expected_date TEXT,
      received_at TEXT,
      created_by_user_id TEXT REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS purchase_order_items (
      id TEXT PRIMARY KEY,
      purchase_order_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      stock_id TEXT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      stock_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      quantity REAL NOT NULL,
      unit_cost_xof INTEGER NOT NULL DEFAULT 0,
      line_total_xof INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS whatsapp_logs (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      recipient_phone TEXT NOT NULL,
      message_type TEXT NOT NULL,
      body TEXT NOT NULL,
      status TEXT NOT NULL,
      external_message_id TEXT,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Ensure users auth/RBAC & tenant columns exist when upgrading an older database file
  const userCols = db.prepare('PRAGMA table_info(users)').all() as Array<{
    name: string;
  }>;
  const colNames = new Set(userCols.map((c) => c.name));
  if (!colNames.has('tenant_id')) {
    db.exec(
      'ALTER TABLE users ADD COLUMN tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE;',
    );
  }
  if (!colNames.has('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'OWNER';");
  }
  if (!colNames.has('permissions_json')) {
    db.exec(
      "ALTER TABLE users ADD COLUMN permissions_json TEXT NOT NULL DEFAULT '[]';",
    );
  }
  if (!colNames.has('token_version')) {
    db.exec(
      'ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1;',
    );
  }
  if (!colNames.has('last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT;');
  }
  if (!colNames.has('updated_at')) {
    db.exec('ALTER TABLE users ADD COLUMN updated_at TEXT;');
  }

  // Ensure restaurants & stock_alert_settings support printer_settings_json & smtp_* columns
  const restoCols = new Set(
    (db.prepare('PRAGMA table_info(restaurants)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  const defaultPrinterJson =
    '\'{"paperWidth":"80mm","connectionType":"BROWSER","printerHost":"","printerPort":9100,"autoPrintReceipt":false,"autoPrintKitchenTicket":false}\'';
  if (!restoCols.has('printer_settings_json')) {
    db.exec(`ALTER TABLE restaurants ADD COLUMN printer_settings_json TEXT NOT NULL DEFAULT ${defaultPrinterJson};`);
  }
  const tenantCols = new Set(
    (db.prepare('PRAGMA table_info(tenants)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!tenantCols.has('printer_settings_json')) {
    db.exec(`ALTER TABLE tenants ADD COLUMN printer_settings_json TEXT NOT NULL DEFAULT ${defaultPrinterJson};`);
  }

  const alertCols = new Set(
    (db.prepare('PRAGMA table_info(stock_alert_settings)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!alertCols.has('smtp_host')) {
    db.exec("ALTER TABLE stock_alert_settings ADD COLUMN smtp_host TEXT NOT NULL DEFAULT '';");
  }
  if (!alertCols.has('smtp_port')) {
    db.exec('ALTER TABLE stock_alert_settings ADD COLUMN smtp_port INTEGER NOT NULL DEFAULT 587;');
  }
  if (!alertCols.has('smtp_secure')) {
    db.exec('ALTER TABLE stock_alert_settings ADD COLUMN smtp_secure INTEGER NOT NULL DEFAULT 0;');
  }
  if (!alertCols.has('smtp_user')) {
    db.exec("ALTER TABLE stock_alert_settings ADD COLUMN smtp_user TEXT NOT NULL DEFAULT '';");
  }
  if (!alertCols.has('smtp_pass')) {
    db.exec("ALTER TABLE stock_alert_settings ADD COLUMN smtp_pass TEXT NOT NULL DEFAULT '';");
  }
  if (!alertCols.has('smtp_from')) {
    db.exec("ALTER TABLE stock_alert_settings ADD COLUMN smtp_from TEXT NOT NULL DEFAULT '';");
  }

  if (!colNames.has('email_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;');
  }
  if (!colNames.has('email_verified_at')) {
    db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT;');
  }
  if (!colNames.has('pin_hash')) {
    db.exec('ALTER TABLE users ADD COLUMN pin_hash TEXT;');
  }

  if (!restoCols.has('whatsapp_enabled')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN whatsapp_enabled INTEGER NOT NULL DEFAULT 0;');
  }
  if (!restoCols.has('whatsapp_phone_number_id')) {
    db.exec("ALTER TABLE restaurants ADD COLUMN whatsapp_phone_number_id TEXT NOT NULL DEFAULT '';");
  }
  if (!restoCols.has('whatsapp_access_token')) {
    db.exec("ALTER TABLE restaurants ADD COLUMN whatsapp_access_token TEXT NOT NULL DEFAULT '';");
  }

  const tblCols = new Set(
    (db.prepare('PRAGMA table_info(dining_tables)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!tblCols.has('pos_x')) {
    db.exec('ALTER TABLE dining_tables ADD COLUMN pos_x INTEGER NOT NULL DEFAULT 40;');
  }
  if (!tblCols.has('pos_y')) {
    db.exec('ALTER TABLE dining_tables ADD COLUMN pos_y INTEGER NOT NULL DEFAULT 40;');
  }
  if (!tblCols.has('shape')) {
    db.exec("ALTER TABLE dining_tables ADD COLUMN shape TEXT NOT NULL DEFAULT 'ROUND';");
  }

  const leadCols = new Set(
    (db.prepare('PRAGMA table_info(contact_leads)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!leadCols.has('status')) {
    db.exec("ALTER TABLE contact_leads ADD COLUMN status TEXT NOT NULL DEFAULT 'NEW';");
  }
  if (!leadCols.has('admin_notes')) {
    db.exec("ALTER TABLE contact_leads ADD COLUMN admin_notes TEXT NOT NULL DEFAULT '';");
  }
  if (!leadCols.has('converted_restaurant_id')) {
    db.exec('ALTER TABLE contact_leads ADD COLUMN converted_restaurant_id TEXT;');
  }

  const subCols = new Set(
    (db.prepare('PRAGMA table_info(subscriptions)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!subCols.has('auto_renew')) {
    db.exec('ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER NOT NULL DEFAULT 1;');
  }
  if (!subCols.has('preferred_payment_method')) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN preferred_payment_method TEXT NOT NULL DEFAULT 'WAVE';");
  }
  if (!subCols.has('last_paydunya_token')) {
    db.exec("ALTER TABLE subscriptions ADD COLUMN last_paydunya_token TEXT NOT NULL DEFAULT '';");
  }

  const invCols = new Set(
    (db.prepare('PRAGMA table_info(platform_invoices)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!invCols.has('paydunya_token')) {
    db.exec("ALTER TABLE platform_invoices ADD COLUMN paydunya_token TEXT NOT NULL DEFAULT '';");
  }
  if (!invCols.has('checkout_url')) {
    db.exec("ALTER TABLE platform_invoices ADD COLUMN checkout_url TEXT NOT NULL DEFAULT '';");
  }
  if (!invCols.has('plan_id')) {
    db.exec('ALTER TABLE platform_invoices ADD COLUMN plan_id TEXT;');
  }
  if (!invCols.has('billing_cycle')) {
    db.exec("ALTER TABLE platform_invoices ADD COLUMN billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY';");
  }
  if (!invCols.has('is_renewal')) {
    db.exec('ALTER TABLE platform_invoices ADD COLUMN is_renewal INTEGER NOT NULL DEFAULT 0;');
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_id ON users(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_status ON users(tenant_id, status);
    CREATE INDEX IF NOT EXISTS idx_users_tenant_role ON users(tenant_id, role);
    CREATE INDEX IF NOT EXISTS idx_platform_invoices_paydunya_token ON platform_invoices(paydunya_token);
    CREATE INDEX IF NOT EXISTS idx_auth_tokens_hash ON auth_tokens(token_hash, token_type);

    INSERT OR IGNORE INTO tenants (
      id, name, slug, email, phone, address, city, country, currency, timezone,
      tax_rate_percent, service_fee_percent, opening_hours, paydunya_mode,
      paydunya_public_key, paydunya_private_key, paydunya_token, status, deleted_at, created_at
    )
    SELECT id, name, slug, email, phone, address, city, country, currency, timezone,
           tax_rate_percent, service_fee_percent, opening_hours, paydunya_mode,
           paydunya_public_key, paydunya_private_key, paydunya_token, status, deleted_at, created_at
    FROM restaurants;

    UPDATE users
    SET tenant_id = (
      SELECT rm.restaurant_id FROM restaurant_members rm WHERE rm.user_id = users.id LIMIT 1
    )
    WHERE tenant_id IS NULL AND global_role != 'SUPER_ADMIN';

    CREATE TRIGGER IF NOT EXISTS trg_restaurants_insert_tenant
    AFTER INSERT ON restaurants
    BEGIN
      INSERT OR REPLACE INTO tenants (
        id, name, slug, email, phone, address, city, country, currency, timezone,
        tax_rate_percent, service_fee_percent, opening_hours, paydunya_mode,
        paydunya_public_key, paydunya_private_key, paydunya_token, status, deleted_at, created_at
      ) VALUES (
        NEW.id, NEW.name, NEW.slug, NEW.email, NEW.phone, NEW.address, NEW.city, NEW.country, NEW.currency, NEW.timezone,
        NEW.tax_rate_percent, NEW.service_fee_percent, NEW.opening_hours, NEW.paydunya_mode,
        NEW.paydunya_public_key, NEW.paydunya_private_key, NEW.paydunya_token, NEW.status, NEW.deleted_at, NEW.created_at
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_restaurants_update_tenant
    AFTER UPDATE ON restaurants
    BEGIN
      UPDATE tenants SET
        name = NEW.name,
        slug = NEW.slug,
        email = NEW.email,
        phone = NEW.phone,
        address = NEW.address,
        city = NEW.city,
        country = NEW.country,
        currency = NEW.currency,
        timezone = NEW.timezone,
        tax_rate_percent = NEW.tax_rate_percent,
        service_fee_percent = NEW.service_fee_percent,
        opening_hours = NEW.opening_hours,
        paydunya_mode = NEW.paydunya_mode,
        paydunya_public_key = NEW.paydunya_public_key,
        paydunya_private_key = NEW.paydunya_private_key,
        paydunya_token = NEW.paydunya_token,
        status = NEW.status,
        deleted_at = NEW.deleted_at
      WHERE id = NEW.id;
    END;

    CREATE TRIGGER IF NOT EXISTS trg_restaurants_delete_tenant
    AFTER DELETE ON restaurants
    BEGIN
      DELETE FROM tenants WHERE id = OLD.id;
    END;
  `);

  // ── New feature tables & columns (v2 operational suite) ──────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_combos (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price_xof INTEGER NOT NULL,
      image_url TEXT,
      is_daily_special INTEGER NOT NULL DEFAULT 0,
      items_json TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS promotions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      code TEXT,
      promo_type TEXT NOT NULL DEFAULT 'PROMO_CODE',
      discount_type TEXT NOT NULL DEFAULT 'PERCENT',
      discount_value INTEGER NOT NULL DEFAULT 10,
      min_order_xof INTEGER NOT NULL DEFAULT 0,
      days_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
      start_time TEXT NOT NULL DEFAULT '17:00',
      end_time TEXT NOT NULL DEFAULT '20:00',
      category_id TEXT,
      max_uses INTEGER,
      uses_count INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cash_register_sessions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      z_number TEXT NOT NULL DEFAULT '',
      opened_by_user_id TEXT REFERENCES users(id),
      opened_by_name TEXT NOT NULL,
      opening_float_xof INTEGER NOT NULL DEFAULT 0,
      opened_at TEXT NOT NULL,
      closed_by_user_id TEXT REFERENCES users(id),
      closed_by_name TEXT,
      closed_at TEXT,
      status TEXT NOT NULL DEFAULT 'OPEN',
      expected_cash_xof INTEGER NOT NULL DEFAULT 0,
      expected_mobile_xof INTEGER NOT NULL DEFAULT 0,
      expected_card_xof INTEGER NOT NULL DEFAULT 0,
      counted_cash_xof INTEGER NOT NULL DEFAULT 0,
      counted_mobile_xof INTEGER NOT NULL DEFAULT 0,
      counted_card_xof INTEGER NOT NULL DEFAULT 0,
      variance_xof INTEGER NOT NULL DEFAULT 0,
      total_sales_xof INTEGER NOT NULL DEFAULT 0,
      refunds_xof INTEGER NOT NULL DEFAULT 0,
      orders_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS table_calls (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      table_id TEXT NOT NULL REFERENCES dining_tables(id) ON DELETE CASCADE,
      table_label TEXT NOT NULL,
      call_type TEXT NOT NULL DEFAULT 'WAITER',
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'PENDING',
      acknowledged_by_name TEXT,
      acknowledged_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS loyalty_transactions (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
      points_delta INTEGER NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS customer_reviews (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
      order_number TEXT NOT NULL DEFAULT '',
      table_label TEXT NOT NULL DEFAULT '',
      customer_name TEXT NOT NULL DEFAULT 'Client',
      rating INTEGER NOT NULL,
      service_rating INTEGER NOT NULL DEFAULT 5,
      food_rating INTEGER NOT NULL DEFAULT 5,
      speed_rating INTEGER NOT NULL DEFAULT 5,
      waiter_name TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT 'QR_ORDER',
      comment TEXT NOT NULL DEFAULT '',
      reply TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_counts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      stock_section TEXT NOT NULL DEFAULT 'ALL',
      status TEXT NOT NULL DEFAULT 'VALIDATED',
      notes TEXT NOT NULL DEFAULT '',
      total_variance_xof INTEGER NOT NULL DEFAULT 0,
      created_by_name TEXT NOT NULL DEFAULT '',
      validated_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_count_lines (
      id TEXT PRIMARY KEY,
      inventory_count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
      stock_id TEXT NOT NULL REFERENCES stocks(id) ON DELETE CASCADE,
      stock_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'kg',
      expected_qty REAL NOT NULL,
      counted_qty REAL NOT NULL,
      variance_qty REAL NOT NULL,
      unit_cost_xof INTEGER NOT NULL DEFAULT 0,
      variance_xof INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS staff_shifts (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_name TEXT NOT NULL,
      role TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS staff_time_clocks (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      staff_name TEXT NOT NULL,
      role TEXT NOT NULL,
      clock_in_at TEXT NOT NULL,
      clock_out_at TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 0,
      notes TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS b2b_invoices (
      id TEXT PRIMARY KEY,
      restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
      invoice_number TEXT UNIQUE NOT NULL,
      doc_type TEXT NOT NULL DEFAULT 'PROFORMA',
      client_name TEXT NOT NULL,
      client_company TEXT NOT NULL DEFAULT '',
      client_tax_id TEXT NOT NULL DEFAULT '',
      client_email TEXT NOT NULL DEFAULT '',
      client_phone TEXT NOT NULL DEFAULT '',
      client_address TEXT NOT NULL DEFAULT '',
      items_json TEXT NOT NULL DEFAULT '[]',
      subtotal_ht_xof INTEGER NOT NULL DEFAULT 0,
      tax_rate_percent REAL NOT NULL DEFAULT 18.0,
      tax_xof INTEGER NOT NULL DEFAULT 0,
      total_ttc_xof INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'DRAFT',
      due_date TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
  `);

  const defaultZonesJson =
    '\'[{"id":"zone_cocody","name":"Cocody / Plateau","feeXof":1500,"minOrderXof":5000},{"id":"zone_marcory","name":"Marcory / Zone 4","feeXof":2000,"minOrderXof":5000},{"id":"zone_yop","name":"Yopougon / Abobo","feeXof":2500,"minOrderXof":8000}]\'';
  const defaultSlotsJson =
    '\'["Dès que possible (20 min)","12:30 - 13:00","13:00 - 13:30","19:30 - 20:00","20:00 - 20:30"]\'';
  if (!restoCols.has('storefront_enabled')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN storefront_enabled INTEGER NOT NULL DEFAULT 1;');
  }
  if (!restoCols.has('delivery_enabled')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN delivery_enabled INTEGER NOT NULL DEFAULT 1;');
  }
  if (!restoCols.has('delivery_zones_json')) {
    db.exec(`ALTER TABLE restaurants ADD COLUMN delivery_zones_json TEXT NOT NULL DEFAULT ${defaultZonesJson};`);
  }
  if (!restoCols.has('pickup_slots_json')) {
    db.exec(`ALTER TABLE restaurants ADD COLUMN pickup_slots_json TEXT NOT NULL DEFAULT ${defaultSlotsJson};`);
  }
  if (!restoCols.has('loyalty_enabled')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN loyalty_enabled INTEGER NOT NULL DEFAULT 1;');
  }
  if (!restoCols.has('loyalty_points_per_1000_xof')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN loyalty_points_per_1000_xof INTEGER NOT NULL DEFAULT 10;');
  }
  if (!restoCols.has('loyalty_xof_per_point')) {
    db.exec('ALTER TABLE restaurants ADD COLUMN loyalty_xof_per_point INTEGER NOT NULL DEFAULT 25;');
  }

  const menuCols = new Set(
    (db.prepare('PRAGMA table_info(menu_items)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!menuCols.has('option_groups_json')) {
    db.exec("ALTER TABLE menu_items ADD COLUMN option_groups_json TEXT NOT NULL DEFAULT '[]';");
  }

  const orderCols = new Set(
    (db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!orderCols.has('customer_phone')) {
    db.exec("ALTER TABLE orders ADD COLUMN customer_phone TEXT NOT NULL DEFAULT '';");
  }
  if (!orderCols.has('delivery_address')) {
    db.exec("ALTER TABLE orders ADD COLUMN delivery_address TEXT NOT NULL DEFAULT '';");
  }
  if (!orderCols.has('delivery_zone')) {
    db.exec("ALTER TABLE orders ADD COLUMN delivery_zone TEXT NOT NULL DEFAULT '';");
  }
  if (!orderCols.has('delivery_fee_xof')) {
    db.exec('ALTER TABLE orders ADD COLUMN delivery_fee_xof INTEGER NOT NULL DEFAULT 0;');
  }
  if (!orderCols.has('scheduled_slot')) {
    db.exec("ALTER TABLE orders ADD COLUMN scheduled_slot TEXT NOT NULL DEFAULT '';");
  }
  if (!orderCols.has('promo_code')) {
    db.exec("ALTER TABLE orders ADD COLUMN promo_code TEXT NOT NULL DEFAULT '';");
  }
  if (!orderCols.has('loyalty_points_used')) {
    db.exec('ALTER TABLE orders ADD COLUMN loyalty_points_used INTEGER NOT NULL DEFAULT 0;');
  }
  if (!orderCols.has('loyalty_points_earned')) {
    db.exec('ALTER TABLE orders ADD COLUMN loyalty_points_earned INTEGER NOT NULL DEFAULT 0;');
  }

  const smCols = new Set(
    (db.prepare('PRAGMA table_info(stock_movements)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!smCols.has('waste_category')) {
    db.exec("ALTER TABLE stock_movements ADD COLUMN waste_category TEXT NOT NULL DEFAULT '';");
  }

  const stockCols = new Set(
    (db.prepare('PRAGMA table_info(stocks)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!stockCols.has('stock_section')) {
    db.exec("ALTER TABLE stocks ADD COLUMN stock_section TEXT NOT NULL DEFAULT 'KITCHEN';");
    db.exec("UPDATE stocks SET stock_section = 'BEVERAGE' WHERE id = 'stk_4';");
  }

  const invCountCols = new Set(
    (db.prepare('PRAGMA table_info(inventory_counts)').all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (!invCountCols.has('stock_section')) {
    db.exec("ALTER TABLE inventory_counts ADD COLUMN stock_section TEXT NOT NULL DEFAULT 'ALL';");
  }

  const reviewTableInfo = db.prepare('PRAGMA table_info(customer_reviews)').all() as Array<{
    name: string;
    notnull: number;
  }>;
  const reviewColNames = new Set(reviewTableInfo.map((c) => c.name));
  const reviewOrderIdCol = reviewTableInfo.find((c) => c.name === 'order_id');
  if (!reviewColNames.has('service_rating') || reviewOrderIdCol?.notnull === 1) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec('BEGIN IMMEDIATE;');
    try {
      db.exec(`
        CREATE TABLE customer_reviews_v2 (
          id TEXT PRIMARY KEY,
          restaurant_id TEXT NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
          order_id TEXT UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
          order_number TEXT NOT NULL DEFAULT '',
          table_label TEXT NOT NULL DEFAULT '',
          customer_name TEXT NOT NULL DEFAULT 'Client',
          rating INTEGER NOT NULL,
          service_rating INTEGER NOT NULL DEFAULT 5,
          food_rating INTEGER NOT NULL DEFAULT 5,
          speed_rating INTEGER NOT NULL DEFAULT 5,
          waiter_name TEXT NOT NULL DEFAULT '',
          channel TEXT NOT NULL DEFAULT 'QR_ORDER',
          comment TEXT NOT NULL DEFAULT '',
          reply TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );
      `);
      db.exec(`
        INSERT INTO customer_reviews_v2 (
          id, restaurant_id, order_id, order_number, table_label, customer_name,
          rating, service_rating, food_rating, speed_rating, waiter_name, channel,
          comment, reply, created_at
        )
        SELECT id, restaurant_id, order_id, order_number, table_label, customer_name,
               rating,
               ${reviewColNames.has('service_rating') ? 'service_rating' : 'rating'},
               ${reviewColNames.has('food_rating') ? 'food_rating' : 'rating'},
               ${reviewColNames.has('speed_rating') ? 'speed_rating' : 'rating'},
               ${reviewColNames.has('waiter_name') ? 'waiter_name' : "''"},
               ${reviewColNames.has('channel') ? 'channel' : "'QR_ORDER'"},
               comment, reply, created_at
        FROM customer_reviews;
      `);
      db.exec('DROP TABLE customer_reviews;');
      db.exec('ALTER TABLE customer_reviews_v2 RENAME TO customer_reviews;');
      db.exec('COMMIT;');
    } catch (err) {
      db.exec('ROLLBACK;');
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }

  // Additive compatibility migration for existing local SQLite databases.
  const existingOrderColumns = new Set(
    (db.pragma('table_info(orders)') as Array<{ name: string }>).map((column) => column.name),
  );
  const missingOrderColumns: Array<[string, string]> = [
    ['customer_phone', 'TEXT'],
    ['delivery_address', 'TEXT'],
    ['delivery_zone', 'TEXT'],
    ['delivery_fee_xof', 'INTEGER NOT NULL DEFAULT 0'],
    ['scheduled_slot', 'TEXT'],
    ['promo_code', 'TEXT'],
    ['loyalty_points_used', 'INTEGER NOT NULL DEFAULT 0'],
    ['loyalty_points_earned', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [column, definition] of missingOrderColumns) {
    if (!existingOrderColumns.has(column)) {
      db.exec(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
    }
  }

  const applied = db
    .prepare('SELECT COUNT(*) as c FROM schema_migrations WHERE version = 1')
    .get() as { c: number };
  if (applied.c === 0) {
    db.prepare(
      'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    ).run(1, 'initial_restomax_schema_and_tenants_users', new Date().toISOString());
  }
}

function seedDatabaseIfEmpty(db: SqliteDatabase): void {
  const existingUsers = db
    .prepare('SELECT COUNT(*) as c FROM users')
    .get() as { c: number };
  if (existingUsers.c > 0) return;

  const now = new Date().toISOString();
  const daysAgo = (d: number, hour = 12) => {
    const dt = new Date(Date.now() - d * 86400000);
    dt.setHours(hour, 15, 0, 0);
    return dt.toISOString();
  };
  const inDays = (d: number) =>
    new Date(Date.now() + d * 86400000).toISOString();

  // 1. Platform Settings (Configurable public contact coordinates - no invented physical addresses)
  const settings = [
    ['contact_email', 'contact@restomax.ci'],
    ['contact_phone', '+225 00 00 00 00 00 (Numéro de démonstration)'],
    ['commercial_region', 'Abidjan, Côte d’Ivoire · Zone UEMOA'],
    ['default_trial_days', '14'],
    ['platform_currency', 'XOF'],
  ];
  const insertSetting = db.prepare(
    'INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, ?)',
  );
  for (const [k, v] of settings) {
    insertSetting.run(k, v, now);
  }

  // 2. Configurable SaaS Plans (clearly marked as demo tariffs administrable from Super-admin)
  const plans = [
    {
      id: 'plan_essentiel',
      code: 'ESSENTIEL',
      name: 'Essentiel',
      tagline: 'Pour les maquis, cafés et petits restaurants en lancement',
      monthly: 25000,
      yearly: 250000,
      trial: 14,
      tables: 15,
      staff: 6,
      items: 80,
      featured: 0,
      features: [
        'Caisse POS tactile & reçus',
        'Gestion jusqu’à 15 tables',
        'Menu digital QR Code par table',
        'Suivi des commandes en temps réel',
        'Jusqu’à 6 comptes employés',
        'Support email en français',
      ],
    },
    {
      id: 'plan_pro',
      code: 'PROFESSIONNEL',
      name: 'Professionnel',
      tagline: 'Pour les restaurants structurés, lounges et brasseries',
      monthly: 55000,
      yearly: 550000,
      trial: 14,
      tables: 60,
      staff: 25,
      items: 350,
      featured: 1,
      features: [
        'Toutes les fonctions Essentiel',
        'Écrans KDS Cuisine & Bar séparés',
        'Gestion avancée des stocks & alertes',
        'Paiements partiels, partagés & Mobile Money (PayDunya)',
        'Fidélité clients & réservations',
        'Rapports financiers & marges FCFA',
      ],
    },
    {
      id: 'plan_premium',
      code: 'PREMIUM',
      name: 'Premium',
      tagline: 'Pour les groupes multi-sites et établissements à fort volume',
      monthly: 110000,
      yearly: 1100000,
      trial: 14,
      tables: 250,
      staff: 100,
      items: 1500,
      featured: 0,
      features: [
        'Toutes les fonctions Professionnel',
        'Tables, personnel & catalogue étendus',
        'Permissions granulaires personnalisées',
        'Exports comptables & audit sécurité complet',
        'Accompagnement déploiement prioritaire',
        'API & intégrations marchandes dédiées',
      ],
    },
  ];
  const insertPlan = db.prepare(`
    INSERT INTO plans (
      id, code, name, tagline, price_monthly_xof, price_yearly_xof,
      trial_days, max_tables, max_staff, max_menu_items, is_demo_pricing,
      is_featured, features_json, active, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 1, ?)
  `);
  for (const p of plans) {
    insertPlan.run(
      p.id,
      p.code,
      p.name,
      p.tagline,
      p.monthly,
      p.yearly,
      p.trial,
      p.tables,
      p.staff,
      p.items,
      p.featured,
      JSON.stringify(p.features),
      now,
    );
  }

  // 3. Demo Restaurants (2 isolated tenants to demonstrate multi-tenancy)
  const resto1Id = 'rest_sillage_01';
  const resto2Id = 'rest_plateau_02';
  const resto3Id = 'rest_bassam_03';

  const insertResto = db.prepare(`
    INSERT INTO restaurants (
      id, name, slug, email, phone, address, city, country, currency,
      timezone, tax_rate_percent, service_fee_percent, opening_hours,
      paydunya_mode, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Côte d''Ivoire', 'XOF', 'Africa/Abidjan', ?, ?, ?, 'TEST', ?, ?)
  `);
  insertResto.run(
    resto1Id,
    'Le Sillage Lagune (Démo)',
    'le-sillage-lagune',
    'direction@lesillage-demo.ci',
    '+225 07 00 00 01 01',
    'Boulevard Lagunaire, Zone 4 (Adresse démo)',
    'Abidjan',
    18,
    0,
    '11:00 - 00:00',
    'ACTIVE',
    daysAgo(45),
  );
  insertResto.run(
    resto2Id,
    'La Terrasse du Plateau (Démo)',
    'terrasse-du-plateau',
    'contact@terrasse-demo.ci',
    '+225 05 00 00 02 02',
    'Avenue Chardy, Plateau (Adresse démo)',
    'Abidjan',
    18,
    0,
    '07:30 - 22:30',
    'TRIAL',
    daysAgo(6),
  );
  insertResto.run(
    resto3Id,
    'Bistro Océan Bassam (Démo)',
    'bistro-ocean-bassam',
    'ocean@bassam-demo.ci',
    '+225 01 00 00 03 03',
    'Quartier France (Adresse démo)',
    'Grand-Bassam',
    18,
    5,
    '10:00 - 23:00',
    'SUSPENDED',
    daysAgo(70),
  );

  // 4. Users (Super-admin + Tenant-isolated Restaurant staff with explicit RBAC roles)
  const demoPassHash = bcrypt.hashSync('RestoMax2026!', 10);
  const demoPinHash = bcrypt.hashSync('1234', 10);
  const insertUser = db.prepare(`
    INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role, global_role, permissions_json, status, email_verified, email_verified_at, pin_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', 'ACTIVE', 1, ?, ?, ?)
  `);
  insertUser.run(
    'usr_superadmin',
    null,
    'superadmin@restomax.ci',
    demoPassHash,
    'Amadou Koné',
    '+225 07 00 00 00 01',
    'SUPER_ADMIN',
    'SUPER_ADMIN',
    now,
    null,
    daysAgo(90),
  );
  insertUser.run(
    'usr_owner_1',
    resto1Id,
    'proprietaire@lesillage.ci',
    demoPassHash,
    'Awa Touré',
    '+225 07 00 00 01 10',
    'OWNER',
    'USER',
    now,
    demoPinHash,
    daysAgo(45),
  );
  insertUser.run(
    'usr_manager_1',
    resto1Id,
    'manager@lesillage.ci',
    demoPassHash,
    'Jean-Marc Kouassi',
    '+225 07 00 00 01 11',
    'MANAGER',
    'USER',
    now,
    demoPinHash,
    daysAgo(40),
  );
  insertUser.run(
    'usr_cashier_1',
    resto1Id,
    'caisse@lesillage.ci',
    demoPassHash,
    'Mariam Bamba',
    '+225 07 00 00 01 12',
    'CASHIER',
    'USER',
    now,
    demoPinHash,
    daysAgo(35),
  );
  insertUser.run(
    'usr_waiter_1',
    resto1Id,
    'serveur@lesillage.ci',
    demoPassHash,
    'Cédric Yao',
    '+225 07 00 00 01 13',
    'WAITER',
    'USER',
    now,
    demoPinHash,
    daysAgo(30),
  );
  insertUser.run(
    'usr_kitchen_1',
    resto1Id,
    'cuisine@lesillage.ci',
    demoPassHash,
    'Chef Ibrahim Diallo',
    '+225 07 00 00 01 14',
    'KITCHEN_BAR',
    'USER',
    now,
    demoPinHash,
    daysAgo(30),
  );
  insertUser.run(
    'usr_owner_2',
    resto2Id,
    'proprietaire@terrasse.ci',
    demoPassHash,
    'Fatoumata Coulibaly',
    '+225 05 00 00 02 10',
    'OWNER',
    'USER',
    now,
    demoPinHash,
    daysAgo(6),
  );
  insertUser.run(
    'usr_owner_3',
    resto3Id,
    'proprietaire@bassam.ci',
    demoPassHash,
    'Koffi Mensah',
    '+225 01 00 00 03 10',
    'OWNER',
    'USER',
    now,
    demoPinHash,
    daysAgo(70),
  );

  const insertMember = db.prepare(`
    INSERT INTO restaurant_members (id, restaurant_id, user_id, role, custom_permissions_json, status, created_at)
    VALUES (?, ?, ?, ?, '[]', 'ACTIVE', ?)
  `);
  insertMember.run('mem_1', resto1Id, 'usr_owner_1', 'OWNER', daysAgo(45));
  insertMember.run('mem_2', resto1Id, 'usr_manager_1', 'MANAGER', daysAgo(40));
  insertMember.run('mem_3', resto1Id, 'usr_cashier_1', 'CASHIER', daysAgo(35));
  insertMember.run('mem_4', resto1Id, 'usr_waiter_1', 'WAITER', daysAgo(30));
  insertMember.run('mem_5', resto1Id, 'usr_kitchen_1', 'KITCHEN_BAR', daysAgo(30));
  insertMember.run('mem_6', resto2Id, 'usr_owner_2', 'OWNER', daysAgo(6));
  insertMember.run('mem_7', resto3Id, 'usr_owner_3', 'OWNER', daysAgo(70));

  // 5. Subscriptions & Platform Invoices (Circuit A)
  const insertSub = db.prepare(`
    INSERT INTO subscriptions (id, restaurant_id, plan_id, billing_cycle, status, trial_ends_at, current_period_start, current_period_end, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertSub.run('sub_1', resto1Id, 'plan_pro', 'MONTHLY', 'ACTIVE', null, daysAgo(15), inDays(15), daysAgo(45));
  insertSub.run('sub_2', resto2Id, 'plan_essentiel', 'MONTHLY', 'TRIAL', inDays(8), daysAgo(6), inDays(8), daysAgo(6));
  insertSub.run('sub_3', resto3Id, 'plan_pro', 'MONTHLY', 'PAST_DUE', null, daysAgo(40), daysAgo(10), daysAgo(70));

  const insertPlatInv = db.prepare(`
    INSERT INTO platform_invoices (id, invoice_number, restaurant_id, subscription_id, amount_xof, status, payment_method, mode, paid_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'TEST', ?, ?)
  `);
  insertPlatInv.run('pinv_1', 'RMX-2026-0001', resto1Id, 'sub_1', 55000, 'PAID', 'WAVE', daysAgo(45), daysAgo(45));
  insertPlatInv.run('pinv_2', 'RMX-2026-0002', resto1Id, 'sub_1', 55000, 'PAID', 'ORANGE_MONEY', daysAgo(15), daysAgo(15));
  insertPlatInv.run('pinv_3', 'RMX-2026-0003', resto3Id, 'sub_3', 55000, 'PENDING', 'MTN_MOMO', null, daysAgo(10));

  // 6. Menu Categories & Items for Le Sillage Lagune (resto1Id)
  const insertCat = db.prepare(`
    INSERT INTO menu_categories (id, restaurant_id, name, station, sort_order, active)
    VALUES (?, ?, ?, ?, ?, 1)
  `);
  insertCat.run('cat_plats', resto1Id, 'Plats Signature', 'KITCHEN', 1);
  insertCat.run('cat_grillades', resto1Id, 'Grillades & Braises', 'KITCHEN', 2);
  insertCat.run('cat_entrees', resto1Id, 'Entrées & Accompagnements', 'KITCHEN', 3);
  insertCat.run('cat_boissons', resto1Id, 'Bar & Cocktails', 'BAR', 4);

  const insertItem = db.prepare(`
    INSERT INTO menu_items (id, restaurant_id, category_id, name, description, price_xof, cost_price_xof, image_url, available, sort_order, options_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertItem.run(
    'itm_capitaine',
    resto1Id,
    'cat_plats',
    'Capitaine grillé & Attiéké',
    'Filet de capitaine frais mariné aux herbes, attiéké doré, alloco croustillant et sauce tomate fraîche.',
    12500,
    4800,
    '/src/assets/images/dish_capitaine_attieke_1795030466633.jpg',
    1,
    1,
    JSON.stringify([
      { id: 'opt_piment_doux', label: 'Piment à part', priceDeltaXof: 0 },
      { id: 'opt_extra_alloco', label: 'Supplément Alloco', priceDeltaXof: 1500 },
    ]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_poulet',
    resto1Id,
    'cat_grillades',
    'Poulet braisé aux épices',
    'Cuisse de poulet fermier grillée au charbon de bois, pommes grenailles rôties et sauce poivre.',
    9500,
    3600,
    '/src/assets/images/dish_poulet_braise_1795030475827.jpg',
    1,
    2,
    JSON.stringify([
      { id: 'opt_attieke', label: 'Accompagnement Attiéké', priceDeltaXof: 1000 },
      { id: 'opt_frites', label: 'Accompagnement Frites maison', priceDeltaXof: 1000 },
    ]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_kedjenou',
    resto1Id,
    'cat_plats',
    'Kedjenou de pintade',
    'Mijoté traditionnel en canari aux légumes du marché, gingembre frais et riz parfumé.',
    14000,
    5500,
    null,
    1,
    3,
    JSON.stringify([{ id: 'opt_riz_extra', label: 'Portion riz supplémentaire', priceDeltaXof: 1500 }]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_brochettes',
    resto1Id,
    'cat_grillades',
    'Brochettes de bœuf filet',
    'Tendres cubes de filet de bœuf marinés au soja et kankankan, oignons confits.',
    11000,
    4500,
    null,
    1,
    4,
    JSON.stringify([
      { id: 'opt_saignant', label: 'Cuisson saignante', priceDeltaXof: 0 },
      { id: 'opt_bien_cuit', label: 'Bien cuit', priceDeltaXof: 0 },
    ]),
    daysAgo(35),
  );
  insertItem.run(
    'itm_alloco',
    resto1Id,
    'cat_entrees',
    'Assiette d’Alloco doré',
    'Bananes plantains mûres frites à point, servies avec sauce pimentée maison.',
    3500,
    900,
    null,
    1,
    5,
    JSON.stringify([]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_bissap',
    resto1Id,
    'cat_boissons',
    'Bissap Signature Menthe',
    'Infusion glacée de fleurs d’hibiscus, menthe fraîche, zeste d’orange sanguine et sirop de canne.',
    3000,
    600,
    '/src/assets/images/drink_bissap_signature_1795030467101.jpg',
    1,
    6,
    JSON.stringify([{ id: 'opt_sans_sucre', label: 'Sans sucre ajouté', priceDeltaXof: 0 }]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_gingembre',
    resto1Id,
    'cat_boissons',
    'Gnamankoudji Frais',
    'Jus de gingembre pressé à froid, ananas doux et citron vert.',
    2500,
    550,
    null,
    1,
    7,
    JSON.stringify([]),
    daysAgo(40),
  );
  insertItem.run(
    'itm_eau',
    resto1Id,
    'cat_boissons',
    'Eau minérale 1L',
    'Bouteille fraîche 1L plate ou pétillante.',
    1500,
    400,
    null,
    1,
    8,
    JSON.stringify([]),
    daysAgo(40),
  );

  // Also seed basic menu for resto2Id so cross-tenant isolation tests have real data on tenant 2
  insertCat.run('cat_r2_plats', resto2Id, 'Menu Midi', 'KITCHEN', 1);
  insertItem.run(
    'itm_r2_garba',
    resto2Id,
    'cat_r2_plats',
    'Thon braisé du Plateau',
    'Pavé de thon frais grillé et attiéké.',
    8000,
    3000,
    null,
    1,
    1,
    '[]',
    daysAgo(5),
  );

  // 7. Tables & QR Codes
  const insertTable = db.prepare(`
    INSERT INTO dining_tables (id, restaurant_id, zone, label, capacity, status, pos_x, pos_y, shape)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertQr = db.prepare(`
    INSERT INTO qr_codes (id, restaurant_id, table_id, token, version, status, created_at)
    VALUES (?, ?, ?, ?, 1, 'ACTIVE', ?)
  `);
  const tablesSeed = [
    { id: 'tbl_1', zone: 'Terrasse Lagune', label: 'Table 01', cap: 4, status: 'OCCUPIED', token: 'sillage-table-01-v1', x: 60, y: 60, shape: 'ROUND' },
    { id: 'tbl_2', zone: 'Terrasse Lagune', label: 'Table 02', cap: 2, status: 'AVAILABLE', token: 'sillage-table-02-v1', x: 240, y: 60, shape: 'ROUND' },
    { id: 'tbl_3', zone: 'Terrasse Lagune', label: 'Table 03', cap: 6, status: 'OCCUPIED', token: 'sillage-table-03-v1', x: 420, y: 60, shape: 'RECT' },
    { id: 'tbl_4', zone: 'Salle Climatisée', label: 'Table 04', cap: 4, status: 'RESERVED', token: 'sillage-table-04-v1', x: 60, y: 230, shape: 'ROUND' },
    { id: 'tbl_5', zone: 'Salle Climatisée', label: 'Table 05', cap: 4, status: 'AVAILABLE', token: 'sillage-table-05-v1', x: 240, y: 230, shape: 'ROUND' },
    { id: 'tbl_6', zone: 'Salon VIP', label: 'VIP 01', cap: 8, status: 'AVAILABLE', token: 'sillage-vip-01-v1', x: 420, y: 230, shape: 'RECT' },
  ];
  for (const t of tablesSeed) {
    insertTable.run(t.id, resto1Id, t.zone, t.label, t.cap, t.status, t.x, t.y, t.shape);
    insertQr.run(`qr_${t.id}`, resto1Id, t.id, t.token, daysAgo(40));
  }
  insertTable.run('tbl_r2_1', resto2Id, 'Terrasse', 'Table A1', 4, 'AVAILABLE', 60, 60, 'ROUND');
  insertQr.run('qr_tbl_r2_1', resto2Id, 'tbl_r2_1', 'plateau-a1-v1', daysAgo(5));

  // 8. Orders & Payments (Historical + Live active orders for KDS & Dashboard charts)
  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, restaurant_id, order_number, order_type, table_id, customer_name,
      status, subtotal_xof, discount_xof, tax_xof, total_xof, paid_xof,
      notes, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrderItem = db.prepare(`
    INSERT INTO order_items (
      id, order_id, menu_item_id, name, station, unit_price_xof,
      options_summary, options_delta_xof, quantity, line_total_xof, notes, prep_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, '', ?)
  `);
  const insertPay = db.prepare(`
    INSERT INTO payments (id, restaurant_id, order_id, amount_xof, method, status, mode, reference, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'PAID', 'TEST', ?, ?, ?)
  `);

  // Historical paid orders across last 6 days for revenue chart
  const historical = [
    { id: 'ord_h1', num: 'CMD-1001', day: 6, total: 37500, method: 'WAVE', item: 'itm_capitaine', itemName: 'Capitaine grillé & Attiéké', qty: 3, price: 12500 },
    { id: 'ord_h2', num: 'CMD-1002', day: 5, total: 28500, method: 'CASH', item: 'itm_poulet', itemName: 'Poulet braisé aux épices', qty: 3, price: 9500 },
    { id: 'ord_h3', num: 'CMD-1003', day: 4, total: 42000, method: 'ORANGE_MONEY', item: 'itm_kedjenou', itemName: 'Kedjenou de pintade', qty: 3, price: 14000 },
    { id: 'ord_h4', num: 'CMD-1004', day: 3, total: 33000, method: 'MTN_MOMO', item: 'itm_brochettes', itemName: 'Brochettes de bœuf filet', qty: 3, price: 11000 },
    { id: 'ord_h5', num: 'CMD-1005', day: 2, total: 50000, method: 'CARD', item: 'itm_capitaine', itemName: 'Capitaine grillé & Attiéké', qty: 4, price: 12500 },
    { id: 'ord_h6', num: 'CMD-1006', day: 1, total: 45500, method: 'WAVE', item: 'itm_poulet', itemName: 'Poulet braisé aux épices', qty: 4, price: 9500 },
  ];
  for (const h of historical) {
    const dt = daysAgo(h.day, 19);
    const sub = Math.round(h.total / 1.18);
    const tax = h.total - sub;
    insertOrder.run(h.id, resto1Id, h.num, 'DINE_IN', 'tbl_2', 'Client salle', 'PAID', sub, tax, h.total, h.total, '', 'usr_waiter_1', dt, dt);
    insertOrderItem.run(`oi_${h.id}`, h.id, h.item, h.itemName, 'KITCHEN', h.price, '', h.qty, h.qty * h.price, 'SERVED');
    insertPay.run(`pay_${h.id}`, resto1Id, h.id, h.total, h.method, `TEST-${h.num}`, 'usr_cashier_1', dt);
  }

  // Active live orders today (in KDS & occupied tables)
  const todayIso1 = new Date(Date.now() - 18 * 60000).toISOString();
  insertOrder.run('ord_live_1', resto1Id, 'CMD-1007', 'QR_TABLE', 'tbl_1', 'Table 01 (Client QR)', 'IN_PREPARATION', 26271, 4729, 31000, 0, 'Bien chaud svp', null, todayIso1, todayIso1);
  insertOrderItem.run('oi_live_1a', 'ord_live_1', 'itm_capitaine', 'Capitaine grillé & Attiéké', 'KITCHEN', 12500, '', 2, 25000, 'PREPARING');
  insertOrderItem.run('oi_live_1b', 'ord_live_1', 'itm_bissap', 'Bissap Signature Menthe', 'BAR', 3000, '', 2, 6000, 'READY');

  const todayIso2 = new Date(Date.now() - 6 * 60000).toISOString();
  insertOrder.run('ord_live_2', resto1Id, 'CMD-1008', 'DINE_IN', 'tbl_3', 'M. Konaté', 'PENDING', 19492, 3508, 23000, 0, '', 'usr_waiter_1', todayIso2, todayIso2);
  insertOrderItem.run('oi_live_2a', 'ord_live_2', 'itm_poulet', 'Poulet braisé aux épices', 'KITCHEN', 9500, '', 2, 19000, 'PENDING');
  insertOrderItem.run('oi_live_2b', 'ord_live_2', 'itm_alloco', 'Assiette d’Alloco doré', 'KITCHEN', 3500, '', 1, 3500, 'PENDING');

  // Today paid order
  const todayPaid = new Date(Date.now() - 120 * 60000).toISOString();
  insertOrder.run('ord_live_3', resto1Id, 'CMD-1009', 'TAKEAWAY', null, 'Mme Traoré', 'PAID', 23305, 4195, 27500, 27500, '', 'usr_cashier_1', todayPaid, todayPaid);
  insertOrderItem.run('oi_live_3a', 'ord_live_3', 'itm_capitaine', 'Capitaine grillé & Attiéké', 'KITCHEN', 12500, '', 2, 25000, 'SERVED');
  insertOrderItem.run('oi_live_3b', 'ord_live_3', 'itm_gingembre', 'Gnamankoudji Frais', 'BAR', 2500, '', 1, 2500, 'SERVED');
  insertPay.run('pay_live_3', resto1Id, 'ord_live_3', 27500, 'WAVE', 'TEST-WAVE-1009', 'usr_cashier_1', todayPaid);

  // 9. Stocks
  const insertStock = db.prepare(`
    INSERT INTO stocks (id, restaurant_id, name, unit, stock_section, quantity, min_threshold, unit_cost_xof, supplier_name, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertStock.run('stk_1', resto1Id, 'Filet de Capitaine frais', 'kg', 'KITCHEN', 4.5, 8, 4200, 'Pêcherie du Port', now);
  insertStock.run('stk_2', resto1Id, 'Attiéké qualité supérieure', 'kg', 'KITCHEN', 24, 10, 800, 'Coopérative Dabou', now);
  insertStock.run('stk_3', resto1Id, 'Poulet fermier', 'pièce', 'KITCHEN', 18, 12, 2800, 'Fermes d’Azaguié', now);
  insertStock.run('stk_4', resto1Id, 'Fleurs de Bissap séchées', 'kg', 'BEVERAGE', 2.2, 5, 1900, 'Marché d’Adjamé', now);
  insertStock.run('stk_5', resto1Id, 'Banane plantain mûre', 'régime', 'KITCHEN', 9, 4, 3500, 'Producteurs Agboville', now);
  insertStock.run('stk_6', resto1Id, 'Eau minérale Céleste 1L', 'bouteille', 'BEVERAGE', 48, 18, 350, 'Solibra Distribution', now);
  insertStock.run('stk_7', resto1Id, 'Racines de gingembre frais', 'kg', 'BEVERAGE', 7, 3, 1600, 'Marché d’Adjamé', now);

  // 9b. Technical Recipes (Fiches techniques liant plats -> ingrédients)
  const insertRecipe = db.prepare(`
    INSERT INTO menu_item_recipes (id, restaurant_id, menu_item_id, stock_id, quantity_per_unit, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertRecipe.run('rec_1', resto1Id, 'itm_capitaine', 'stk_1', 0.35, now, now);
  insertRecipe.run('rec_2', resto1Id, 'itm_capitaine', 'stk_2', 0.25, now, now);
  insertRecipe.run('rec_3', resto1Id, 'itm_poulet', 'stk_3', 0.5, now, now);
  insertRecipe.run('rec_4', resto1Id, 'itm_alloco', 'stk_5', 0.15, now, now);
  insertRecipe.run('rec_5', resto1Id, 'itm_bissap', 'stk_4', 0.05, now, now);

  // 10. Customers & Reservations & Expenses
  const insertCust = db.prepare(`
    INSERT INTO customers (id, restaurant_id, full_name, phone, email, loyalty_points, total_spent_xof, visits_count, preferences, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertCust.run('cust_1', resto1Id, 'Sékou Bamba', '+225 07 44 11 22 00', 'sekou.bamba@exemple.ci', 420, 185000, 7, 'Table terrasse lagune, peu pimenté', daysAgo(35));
  insertCust.run('cust_2', resto1Id, 'Clarisse Aka', '+225 05 88 22 33 00', 'clarisse.aka@exemple.ci', 280, 112000, 4, 'Bissap sans sucre', daysAgo(20));

  const insertRes = db.prepare(`
    INSERT INTO reservations (id, restaurant_id, customer_name, customer_phone, party_size, reserved_at, table_id, status, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertRes.run('res_1', resto1Id, 'M. Yao & Collègues', '+225 07 12 34 56 00', 4, inDays(0), 'tbl_4', 'CONFIRMED', 'Déjeuner d’affaires 13h00', now);
  insertRes.run('res_2', resto1Id, 'Anniversaire Mme Diabaté', '+225 05 99 88 77 00', 8, inDays(1), 'tbl_6', 'PENDING', 'Salon VIP demandé', now);

  const insertExp = db.prepare(`
    INSERT INTO expenses (id, restaurant_id, category, description, amount_xof, expense_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  insertExp.run('exp_1', resto1Id, 'Approvisionnement', 'Achat poisson frais & vivriers', 65000, daysAgo(2), daysAgo(2));
  insertExp.run('exp_2', resto1Id, 'Énergie & Gaz', 'Recharges gaz cuisine professionnelle', 24000, daysAgo(5), daysAgo(5));

  // 11. Support Tickets & Audit Logs
  db.prepare(`
    INSERT INTO support_tickets (id, restaurant_id, created_by_email, subject, category, priority, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('tkt_1', resto1Id, 'proprietaire@lesillage.ci', 'Configuration imprimante thermique cuisine 80mm', 'Matériel & KDS', 'MEDIUM', 'OPEN', daysAgo(1));
  db.prepare(`
    INSERT INTO ticket_messages (id, ticket_id, author, role, body, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('tmsg_1', 'tkt_1', 'Awa Touré', 'OWNER', 'Bonjour, nous souhaitons connecter notre tablette cuisine en mode continu sur le réseau local.', daysAgo(1));

  const insertAudit = db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, actor_email, actor_role, restaurant_id, action, target_type, target_id, details, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAudit.run('aud_1', 'usr_superadmin', 'superadmin@restomax.ci', 'SUPER_ADMIN', resto3Id, 'RESTAURANT_SUSPENDED', 'RESTAURANT', resto3Id, 'Facture plateforme en retard de paiement', daysAgo(3));
  insertAudit.run('aud_2', 'usr_owner_1', 'proprietaire@lesillage.ci', 'OWNER', resto1Id, 'PLAN_ACTIVATED', 'SUBSCRIPTION', 'sub_1', 'Activation offre Professionnel (TEST)', daysAgo(15));

  // 12. Combos, Promo Code, Option Groups, B2B Proforma & Customer Review (starter demo data)
  db.prepare(`
    UPDATE menu_items SET option_groups_json = ? WHERE id = 'itm_capitaine'
  `).run(
    JSON.stringify([
      {
        id: 'grp_accompagnement',
        name: 'Accompagnement principal',
        required: false,
        multiple: false,
        choices: [
          { id: 'opt_attieke', label: 'Attiéké frais (inclus)', priceDeltaXof: 0 },
          { id: 'opt_alloco_sup', label: 'Portion Alloco doré', priceDeltaXof: 1000 },
        ],
      },
      {
        id: 'grp_supplements',
        name: 'Sauces & Suppléments',
        required: false,
        multiple: true,
        choices: [
          { id: 'opt_piment', label: 'Piment vert maison', priceDeltaXof: 0 },
          { id: 'opt_oignons', label: 'Condiment oignons & tomates', priceDeltaXof: 500 },
        ],
      },
    ]),
  );

  db.prepare(`
    INSERT INTO menu_combos (id, restaurant_id, name, description, price_xof, is_daily_special, items_json, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
  `).run(
    'cmb_1',
    resto1Id,
    'Formule Déjeuner Lagune',
    'Poulet braisé aux épices + Assiette d’Alloco + Bissap Signature Menthe',
    13500,
    1,
    JSON.stringify([
      { label: 'Poulet braisé aux épices', quantity: 1, menuItemId: 'itm_poulet' },
      { label: 'Assiette d’Alloco doré', quantity: 1, menuItemId: 'itm_alloco' },
      { label: 'Bissap Signature Menthe', quantity: 1, menuItemId: 'itm_bissap' },
    ]),
    now,
  );

  db.prepare(`
    INSERT INTO promotions (
      id, restaurant_id, name, code, promo_type, discount_type, discount_value,
      min_order_xof, days_json, start_time, end_time, active, created_at
    ) VALUES (?, ?, ?, ?, 'PROMO_CODE', 'PERCENT', 10, 5000, '[0,1,2,3,4,5,6]', '00:00', '23:59', 1, ?)
  `).run('prm_1', resto1Id, 'Bienvenue Click & Collect -10%', 'BIENVENUE10', now);

  db.prepare(`
    INSERT INTO b2b_invoices (
      id, restaurant_id, invoice_number, doc_type, client_name, client_company,
      client_tax_id, client_email, client_phone, items_json,
      subtotal_ht_xof, tax_rate_percent, tax_xof, total_ttc_xof, status, due_date, notes, created_at
    ) VALUES (?, ?, 'PROF-2026-001', 'PROFORMA', 'Direction RH Ivoire', 'Ivoire Telecom Services', 'CI-ABJ-2024-8812', 'achats@ivoiretelecom.ci', '+225 27 20 00 11 22', ?, 250000, 18, 45000, 295000, 'SENT', ?, 'Déjeuner séminaire 20 personnes', ?)
  `).run(
    'b2b_1',
    resto1Id,
    JSON.stringify([
      { description: 'Formule séminaire Capitaine + Boisson', quantity: 20, unitPriceXof: 12500, lineTotalXof: 250000 },
    ]),
    inDays(15),
    daysAgo(2),
  );

  db.prepare(`
    INSERT INTO customer_reviews (
      id, restaurant_id, order_id, order_number, table_label, customer_name,
      rating, service_rating, food_rating, speed_rating, waiter_name, channel, comment, created_at
    ) VALUES (?, ?, 'ord_h6', 'CMD-1006', 'Table 02', 'Clarisse Aka', 5, 5, 5, 4, 'Moussa Diallo', 'QR_ORDER', 'Accueil rapide et capitaine braisé impeccable.', ?)
  `).run('rev_1', resto1Id, daysAgo(1));
}
