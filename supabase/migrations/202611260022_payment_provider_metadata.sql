-- Provider metadata required to reconcile asynchronous payment confirmations.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_reference text,
  ADD COLUMN IF NOT EXISTS checkout_url text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_payload_json text,
  ADD COLUMN IF NOT EXISTS updated_at text;

CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference_unique
  ON public.payments(provider, provider_reference)
  WHERE provider_reference IS NOT NULL;

ALTER TABLE public.payments ALTER COLUMN status SET DEFAULT 'PENDING';
