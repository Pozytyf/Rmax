-- Add operational tables missing from the first PostgreSQL schema.
CREATE TABLE IF NOT EXISTS public.menu_combos (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_xof INTEGER NOT NULL,
  image_url TEXT,
  is_daily_special INTEGER NOT NULL DEFAULT 0,
  items_json TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.promotions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.cash_register_sessions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  z_number TEXT NOT NULL DEFAULT '',
  opened_by_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
  opened_by_name TEXT NOT NULL,
  opening_float_xof INTEGER NOT NULL DEFAULT 0,
  opened_at TEXT NOT NULL,
  closed_by_user_id TEXT REFERENCES public.users(id) ON DELETE SET NULL,
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

CREATE TABLE IF NOT EXISTS public.table_calls (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  table_id TEXT NOT NULL REFERENCES public.dining_tables(id) ON DELETE CASCADE,
  table_label TEXT NOT NULL,
  call_type TEXT NOT NULL DEFAULT 'WAITER',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'PENDING',
  acknowledged_by_name TEXT,
  acknowledged_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.loyalty_transactions (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  customer_id TEXT NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  order_id TEXT REFERENCES public.orders(id) ON DELETE SET NULL,
  points_delta INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.customer_reviews (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  order_id TEXT UNIQUE REFERENCES public.orders(id) ON DELETE CASCADE,
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

CREATE TABLE IF NOT EXISTS public.inventory_counts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  stock_section TEXT NOT NULL DEFAULT 'ALL',
  status TEXT NOT NULL DEFAULT 'VALIDATED',
  notes TEXT NOT NULL DEFAULT '',
  total_variance_xof INTEGER NOT NULL DEFAULT 0,
  created_by_name TEXT NOT NULL DEFAULT '',
  validated_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.inventory_count_lines (
  id TEXT PRIMARY KEY,
  inventory_count_id TEXT NOT NULL REFERENCES public.inventory_counts(id) ON DELETE CASCADE,
  stock_id TEXT NOT NULL REFERENCES public.stocks(id) ON DELETE CASCADE,
  stock_name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  expected_qty REAL NOT NULL,
  counted_qty REAL NOT NULL,
  variance_qty REAL NOT NULL,
  unit_cost_xof INTEGER NOT NULL DEFAULT 0,
  variance_xof INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS public.staff_shifts (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  role TEXT NOT NULL,
  shift_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.staff_time_clocks (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  staff_name TEXT NOT NULL,
  role TEXT NOT NULL,
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS public.b2b_invoices (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES public.restaurants(id) ON DELETE CASCADE,
  invoice_number TEXT NOT NULL UNIQUE,
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

-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_menu_combos_restaurant_active ON public.menu_combos(restaurant_id, active);
CREATE INDEX IF NOT EXISTS idx_promotions_restaurant_active ON public.promotions(restaurant_id, active);
CREATE INDEX IF NOT EXISTS idx_cash_register_restaurant_status ON public.cash_register_sessions(restaurant_id, status, opened_at);
CREATE INDEX IF NOT EXISTS idx_table_calls_restaurant_status ON public.table_calls(restaurant_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON public.loyalty_transactions(restaurant_id, customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_customer_reviews_restaurant_created ON public.customer_reviews(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inventory_counts_restaurant_created ON public.inventory_counts(restaurant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_count ON public.inventory_count_lines(inventory_count_id);
CREATE INDEX IF NOT EXISTS idx_inventory_count_lines_stock ON public.inventory_count_lines(stock_id);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_restaurant_date ON public.staff_shifts(restaurant_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_staff_shifts_user_date ON public.staff_shifts(user_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_staff_time_clocks_restaurant_in ON public.staff_time_clocks(restaurant_id, clock_in_at);
CREATE INDEX IF NOT EXISTS idx_staff_time_clocks_user_in ON public.staff_time_clocks(user_id, clock_in_at);
CREATE INDEX IF NOT EXISTS idx_b2b_invoices_restaurant_created ON public.b2b_invoices(restaurant_id, created_at);

-- Trusted tenant claims are supplied only by a server-issued Supabase JWT.
CREATE OR REPLACE FUNCTION public.current_tenant_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(COALESCE(
    auth.jwt() ->> 'restaurant_id',
    auth.jwt() -> 'app_metadata' ->> 'restaurant_id',
    ''
  ), '');
$function$;

CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    auth.jwt() ->> 'global_role',
    auth.jwt() -> 'app_metadata' ->> 'global_role',
    ''
  ) = 'SUPER_ADMIN';
$function$;

-- Tenant isolation. Do not grant anon access: public QR/storefront requests go
-- through the authenticated application API. Supabase Realtime requires a
-- trusted JWT with restaurant_id/app_metadata.restaurant_id before these
-- policies can authorize browser subscriptions.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'menu_combos',
    'promotions',
    'cash_register_sessions',
    'table_calls',
    'loyalty_transactions',
    'customer_reviews',
    'inventory_counts',
    'staff_shifts',
    'staff_time_clocks',
    'b2b_invoices'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON public.%I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON public.%I FOR ALL USING (public.is_superadmin() OR restaurant_id = public.current_tenant_id()) WITH CHECK (public.is_superadmin() OR restaurant_id = public.current_tenant_id())',
      tbl, tbl
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role', tbl);
  END LOOP;
END
$$;

ALTER TABLE public.inventory_count_lines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_inventory_count_lines ON public.inventory_count_lines;
CREATE POLICY tenant_isolation_inventory_count_lines ON public.inventory_count_lines
FOR ALL
USING (
  public.is_superadmin()
  OR EXISTS (
    SELECT 1 FROM public.inventory_counts ic
    WHERE ic.id = inventory_count_id
      AND ic.restaurant_id = public.current_tenant_id()
  )
)
WITH CHECK (
  public.is_superadmin()
  OR EXISTS (
    SELECT 1 FROM public.inventory_counts ic
    WHERE ic.id = inventory_count_id
      AND ic.restaurant_id = public.current_tenant_id()
  )
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.inventory_count_lines TO authenticated, service_role;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.orders
    GROUP BY restaurant_id, order_number
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce unique restaurant order numbers: duplicate values exist';
  END IF;
END
$$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_orders_restaurant_order_number
  ON public.orders(restaurant_id, order_number);
