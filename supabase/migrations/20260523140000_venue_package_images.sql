ALTER TABLE public.venue_event_packages
  ADD COLUMN IF NOT EXISTS image_url text,
  ADD COLUMN IF NOT EXISTS images text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.venue_event_packages.image_url IS 'Primary package cover image URL';
COMMENT ON COLUMN public.venue_event_packages.images IS 'Additional package gallery image URLs';
