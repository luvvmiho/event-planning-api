-- venues: draft | published | archived  →  enabled | disabled
ALTER TABLE public.venues ALTER COLUMN status DROP DEFAULT;

ALTER TYPE public.venue_status RENAME TO venue_status_old;

CREATE TYPE public.venue_status AS ENUM ('enabled', 'disabled');

ALTER TABLE public.venues
  ALTER COLUMN status TYPE public.venue_status
  USING (
    CASE status::text
      WHEN 'published' THEN 'enabled'::public.venue_status
      ELSE 'disabled'::public.venue_status
    END
  );

ALTER TABLE public.venues ALTER COLUMN status SET DEFAULT 'enabled';

DROP TYPE public.venue_status_old;

COMMENT ON COLUMN public.venues.status IS 'enabled=public catalog, disabled=hidden';

-- provider_services: draft | published | archived  →  enabled | disabled
ALTER TABLE public.provider_services ALTER COLUMN status DROP DEFAULT;

ALTER TYPE public.service_status RENAME TO service_status_old;

CREATE TYPE public.service_status AS ENUM ('enabled', 'disabled');

ALTER TABLE public.provider_services
  ALTER COLUMN status TYPE public.service_status
  USING (
    CASE status::text
      WHEN 'published' THEN 'enabled'::public.service_status
      ELSE 'disabled'::public.service_status
    END
  );

ALTER TABLE public.provider_services ALTER COLUMN status SET DEFAULT 'enabled';

DROP TYPE public.service_status_old;

COMMENT ON COLUMN public.provider_services.status IS 'enabled=public catalog, disabled=hidden';
