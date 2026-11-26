-- Public storefront and loyalty configuration for each restaurant.
ALTER TABLE public.restaurants
  ADD COLUMN IF NOT EXISTS loyalty_enabled integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS loyalty_points_per_1000_xof integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS loyalty_xof_per_point integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS storefront_enabled integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS delivery_enabled integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS delivery_zones_json text NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS pickup_slots_json text NOT NULL DEFAULT '[]';
