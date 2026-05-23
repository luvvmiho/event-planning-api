DO $$ BEGIN
  CREATE TYPE public.event_plan_status AS ENUM ('draft', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.event_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Миний арга хэмжээ',
  budget integer NOT NULL CHECK (budget >= 0),
  event_date date,
  guest_count integer CHECK (guest_count IS NULL OR guest_count >= 1),
  notes text,
  status public.event_plan_status NOT NULL DEFAULT 'draft',
  venue_id uuid REFERENCES public.venues(id) ON DELETE SET NULL,
  venue_package_id uuid REFERENCES public.venue_event_packages(id) ON DELETE SET NULL,
  venue_booking_date date,
  venue_guest_count integer CHECK (venue_guest_count IS NULL OR venue_guest_count >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.event_plan_services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.event_plans(id) ON DELETE CASCADE,
  provider_service_id uuid NOT NULL REFERENCES public.provider_services(id) ON DELETE CASCADE,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, provider_service_id)
);

CREATE INDEX IF NOT EXISTS event_plans_user_id_idx ON public.event_plans (user_id);
CREATE INDEX IF NOT EXISTS event_plan_services_plan_id_idx ON public.event_plan_services (plan_id);
