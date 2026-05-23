DO $$ BEGIN
  CREATE TYPE public.service_kind AS ENUM (
    'car', 'cake', 'photoshoot', 'entertainment', 'decoration', 'catering', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE public.service_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.provider_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  kind public.service_kind NOT NULL DEFAULT 'other',
  short_description text,
  description text,
  price_flat integer NOT NULL CHECK (price_flat >= 0),
  location text,
  image_url text,
  images text[] DEFAULT '{}',
  status public.service_status NOT NULL DEFAULT 'draft',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_services_slug_unique UNIQUE (slug),
  CONSTRAINT provider_services_name_len CHECK (char_length(trim(name)) >= 2)
);

CREATE INDEX IF NOT EXISTS provider_services_provider_id_idx ON public.provider_services (provider_id);
CREATE INDEX IF NOT EXISTS provider_services_status_idx ON public.provider_services (status);
CREATE INDEX IF NOT EXISTS provider_services_kind_idx ON public.provider_services (kind);
