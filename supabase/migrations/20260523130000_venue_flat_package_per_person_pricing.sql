-- Venue-only booking: flat rate. Event packages: per-guest rate.
ALTER TABLE public.venues RENAME COLUMN price_per_person TO price_flat;

ALTER TABLE public.venue_event_packages RENAME COLUMN price_flat TO price_per_person;

COMMENT ON COLUMN public.venues.price_flat IS 'Flat venue rental price (constant, not multiplied by guests)';
COMMENT ON COLUMN public.venue_event_packages.price_per_person IS 'Per-guest price for this event package';
