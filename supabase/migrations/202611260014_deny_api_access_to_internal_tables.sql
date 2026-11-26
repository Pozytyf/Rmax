-- Explicit deny policies document that these tables are never exposed through
-- the Supabase Data API. The server-side database owner remains responsible for
-- privileged application operations.
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'users',
    'sessions',
    'auth_tokens',
    'knex_migrations',
    'knex_migrations_lock'
  ]
  LOOP
    IF to_regclass('public.' || tbl) IS NOT NULL THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tbl);
      EXECUTE format('DROP POLICY IF EXISTS deny_api_access_%I ON public.%I', tbl, tbl);
      EXECUTE format(
        'CREATE POLICY deny_api_access_%I ON public.%I FOR ALL USING (FALSE) WITH CHECK (FALSE)',
        tbl, tbl
      );
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon, authenticated', tbl);
    END IF;
  END LOOP;
END
$$;
