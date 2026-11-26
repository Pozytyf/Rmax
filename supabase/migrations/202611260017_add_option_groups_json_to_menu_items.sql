-- Keep the Supabase SQL bootstrap aligned with the Knex application schema.
ALTER TABLE public.menu_items
  ADD COLUMN IF NOT EXISTS option_groups_json text NOT NULL DEFAULT '[]';
