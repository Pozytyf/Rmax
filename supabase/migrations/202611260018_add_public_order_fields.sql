-- Additive order fields required by QR and storefront order flows.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_phone text,
  ADD COLUMN IF NOT EXISTS delivery_address text,
  ADD COLUMN IF NOT EXISTS delivery_zone text,
  ADD COLUMN IF NOT EXISTS delivery_fee_xof integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scheduled_slot text,
  ADD COLUMN IF NOT EXISTS promo_code text,
  ADD COLUMN IF NOT EXISTS loyalty_points_used integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS loyalty_points_earned integer NOT NULL DEFAULT 0;
