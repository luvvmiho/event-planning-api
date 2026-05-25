CREATE TABLE IF NOT EXISTS public.provider_service_option_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id uuid NOT NULL REFERENCES public.provider_services(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  is_required boolean NOT NULL DEFAULT true,
  max_choices integer NOT NULL DEFAULT 1 CHECK (max_choices >= 1 AND max_choices <= 20),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_service_option_groups_title_len CHECK (char_length(trim(title)) >= 1)
);

CREATE TABLE IF NOT EXISTS public.provider_service_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.provider_service_option_groups(id) ON DELETE CASCADE,
  label text NOT NULL,
  description text,
  price_adjustment integer NOT NULL DEFAULT 0,
  image_url text,
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_service_options_label_len CHECK (char_length(trim(label)) >= 1)
);

CREATE INDEX IF NOT EXISTS provider_service_option_groups_service_id_idx
  ON public.provider_service_option_groups (service_id);

CREATE INDEX IF NOT EXISTS provider_service_options_group_id_idx
  ON public.provider_service_options (group_id);

COMMENT ON TABLE public.provider_service_option_groups IS 'Customer choice groups, e.g. cake flavor or car model';
COMMENT ON TABLE public.provider_service_options IS 'Selectable choices within a service option group';
COMMENT ON COLUMN public.provider_service_options.price_adjustment IS 'Option price; summed for line total when customer selects options (price_flat is not added)';
