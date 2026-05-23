DO $$ BEGIN
  CREATE TYPE public.venue_status AS ENUM ('draft', 'published', 'archived');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS status public.venue_status NOT NULL DEFAULT 'published';

UPDATE public.venues SET status = 'published' WHERE status IS NULL;

CREATE INDEX IF NOT EXISTS venues_status_idx ON public.venues (status);

COMMENT ON COLUMN public.venues.status IS 'draft=hidden, published=public catalog, archived=provider-hidden';
