-- Enforce tenant isolation on the existing Knex-created tables.
-- Browser access is granted only to the authenticated role and only when a
-- trusted JWT carries restaurant_id/app_metadata.restaurant_id.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'restaurant_members',
    'menu_categories',
    'menu_items',
    'dining_tables',
    'qr_codes',
    'orders',
    'payments',
    'stocks',
    'stock_movements',
    'menu_item_recipes',
    'stock_alert_settings',
    'notifications',
    'customers',
    'reservations',
    'expenses',
    'support_tickets',
    'purchase_orders',
    'qr_table_sessions',
    'whatsapp_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_%I ON public.%I', tbl, tbl);
    EXECUTE format(
      'CREATE POLICY tenant_isolation_%I ON public.%I FOR ALL USING (public.is_superadmin() OR restaurant_id = public.current_tenant_id()) WITH CHECK (public.is_superadmin() OR restaurant_id = public.current_tenant_id())',
      tbl, tbl
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, service_role', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon', tbl);
  END LOOP;
END
$$;

-- Tenant root rows and user accounts.
ALTER TABLE public.restaurants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_access_restaurants ON public.restaurants;
CREATE POLICY tenant_self_access_restaurants ON public.restaurants
FOR ALL USING (public.is_superadmin() OR id = public.current_tenant_id())
WITH CHECK (public.is_superadmin() OR id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.restaurants TO authenticated, service_role;
REVOKE ALL ON TABLE public.restaurants FROM anon;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_self_access_tenants ON public.tenants;
CREATE POLICY tenant_self_access_tenants ON public.tenants
FOR ALL USING (public.is_superadmin() OR id = public.current_tenant_id())
WITH CHECK (public.is_superadmin() OR id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenants TO authenticated, service_role;
REVOKE ALL ON TABLE public.tenants FROM anon;

-- User rows contain password and PIN hashes: never expose them through the Data API.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.users FROM anon, authenticated;

-- Internal authentication/session data and Knex migration bookkeeping are backend-only.
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.auth_tokens FROM anon, authenticated;

-- Knex bookkeeping tables exist only after the Knex migration runner has
-- initialized them. A fresh SQL-only Supabase bootstrap must not fail if they
-- have not been created yet.
DO $knex_guard$
BEGIN
  IF to_regclass('public.knex_migrations') IS NOT NULL THEN
    ALTER TABLE public.knex_migrations ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.knex_migrations FROM anon, authenticated;
  END IF;
  IF to_regclass('public.knex_migrations_lock') IS NOT NULL THEN
    ALTER TABLE public.knex_migrations_lock ENABLE ROW LEVEL SECURITY;
    REVOKE ALL ON TABLE public.knex_migrations_lock FROM anon, authenticated;
  END IF;
END;
$knex_guard$;

-- Child records are scoped through their parent tenant-owned row.
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_order_items ON public.order_items;
CREATE POLICY tenant_isolation_order_items ON public.order_items
FOR ALL
USING (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.orders o
             WHERE o.id = order_id AND o.restaurant_id = public.current_tenant_id())
)
WITH CHECK (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.orders o
             WHERE o.id = order_id AND o.restaurant_id = public.current_tenant_id())
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.order_items TO authenticated, service_role;
REVOKE ALL ON TABLE public.order_items FROM anon;

ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_ticket_messages ON public.ticket_messages;
CREATE POLICY tenant_isolation_ticket_messages ON public.ticket_messages
FOR ALL
USING (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.support_tickets t
             WHERE t.id = ticket_id AND t.restaurant_id = public.current_tenant_id())
)
WITH CHECK (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.support_tickets t
             WHERE t.id = ticket_id AND t.restaurant_id = public.current_tenant_id())
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ticket_messages TO authenticated, service_role;
REVOKE ALL ON TABLE public.ticket_messages FROM anon;

ALTER TABLE public.purchase_order_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_purchase_order_items ON public.purchase_order_items;
CREATE POLICY tenant_isolation_purchase_order_items ON public.purchase_order_items
FOR ALL
USING (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.purchase_orders p
             WHERE p.id = purchase_order_id AND p.restaurant_id = public.current_tenant_id())
)
WITH CHECK (
  public.is_superadmin()
  OR EXISTS (SELECT 1 FROM public.purchase_orders p
             WHERE p.id = purchase_order_id AND p.restaurant_id = public.current_tenant_id())
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.purchase_order_items TO authenticated, service_role;
REVOKE ALL ON TABLE public.purchase_order_items FROM anon;

-- Platform-wide tables have narrower access than tenant business data.
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_settings_superadmin_only ON public.platform_settings;
CREATE POLICY platform_settings_superadmin_only ON public.platform_settings
FOR ALL USING (public.is_superadmin())
WITH CHECK (public.is_superadmin());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_settings TO authenticated, service_role;
REVOKE ALL ON TABLE public.platform_settings FROM anon;

ALTER TABLE public.plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS plans_public_read ON public.plans;
CREATE POLICY plans_public_read ON public.plans FOR SELECT USING (active = 1);
GRANT SELECT ON TABLE public.plans TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.plans TO authenticated, service_role;

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_subscriptions ON public.subscriptions;
CREATE POLICY tenant_isolation_subscriptions ON public.subscriptions
FOR ALL USING (public.is_superadmin() OR restaurant_id = public.current_tenant_id())
WITH CHECK (public.is_superadmin() OR restaurant_id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.subscriptions TO authenticated, service_role;
REVOKE ALL ON TABLE public.subscriptions FROM anon;

ALTER TABLE public.platform_invoices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_platform_invoices ON public.platform_invoices;
CREATE POLICY tenant_isolation_platform_invoices ON public.platform_invoices
FOR ALL USING (public.is_superadmin() OR restaurant_id = public.current_tenant_id())
WITH CHECK (public.is_superadmin() OR restaurant_id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_invoices TO authenticated, service_role;
REVOKE ALL ON TABLE public.platform_invoices FROM anon;

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_audit_logs ON public.audit_logs;
CREATE POLICY tenant_isolation_audit_logs ON public.audit_logs
FOR ALL USING (public.is_superadmin() OR restaurant_id = public.current_tenant_id())
WITH CHECK (public.is_superadmin() OR restaurant_id = public.current_tenant_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.audit_logs TO authenticated, service_role;
REVOKE ALL ON TABLE public.audit_logs FROM anon;

ALTER TABLE public.contact_leads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_leads_superadmin_only ON public.contact_leads;
CREATE POLICY contact_leads_superadmin_only ON public.contact_leads
FOR ALL USING (public.is_superadmin())
WITH CHECK (public.is_superadmin());
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contact_leads TO authenticated, service_role;
REVOKE ALL ON TABLE public.contact_leads FROM anon;
