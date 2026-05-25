ALTER TABLE public.provider_services
  ADD COLUMN IF NOT EXISTS contact_phone text,
  ADD COLUMN IF NOT EXISTS contact_email text,
  ADD COLUMN IF NOT EXISTS website text;

COMMENT ON COLUMN public.provider_services.contact_phone IS 'Provider contact phone for this service listing';
COMMENT ON COLUMN public.provider_services.contact_email IS 'Provider contact email for this service listing';
COMMENT ON COLUMN public.provider_services.website IS 'Optional website URL for this service listing';
