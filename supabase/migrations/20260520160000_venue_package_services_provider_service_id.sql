ALTER TABLE public.venue_package_services
  ADD COLUMN IF NOT EXISTS provider_service_id uuid REFERENCES public.provider_services(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS venue_package_services_provider_service_id_idx
  ON public.venue_package_services (provider_service_id);
