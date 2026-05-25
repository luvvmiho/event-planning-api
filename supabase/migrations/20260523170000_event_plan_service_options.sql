ALTER TABLE public.event_plan_services
  ADD COLUMN IF NOT EXISTS selected_option_ids uuid[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.event_plan_services.selected_option_ids IS 'Customer-selected provider_service_options ids for this plan line';
