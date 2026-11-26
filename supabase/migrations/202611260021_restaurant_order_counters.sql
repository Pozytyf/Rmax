-- Atomic per-restaurant order number counters.
CREATE TABLE IF NOT EXISTS public.restaurant_order_counters (
  restaurant_id text PRIMARY KEY REFERENCES public.restaurants(id) ON DELETE CASCADE,
  last_number integer NOT NULL DEFAULT 1000,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.restaurant_order_counters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.restaurant_order_counters FROM anon, authenticated;
DROP POLICY IF EXISTS deny_api_access_restaurant_order_counters ON public.restaurant_order_counters;
CREATE POLICY deny_api_access_restaurant_order_counters
  ON public.restaurant_order_counters
  FOR ALL USING (FALSE) WITH CHECK (FALSE);
