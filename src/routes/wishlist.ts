import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { authenticate } from '../middleware/auth.js';

export const wishlistRouter = new Hono();

const listQuerySchema = z.object({
	page: z.coerce.number().min(1).default(1),
	limit: z.coerce.number().min(1).max(100).default(20),
});

const addBodySchema = z.object({
	venue_id: z.string().uuid(),
});

const venueCardSelect =
	'id, slug, name, short_description, location, district, capacity_min, capacity_max, price_flat, rating, review_count, image_url, images, is_featured, is_new, created_at, categories(id, slug, name)';

wishlistRouter.get('/', authenticate, zValidator('query', listQuerySchema), async (c) => {
	const user = c.var.user;
	const { page, limit } = c.req.valid('query');
	const offset = (page - 1) * limit;

	const { data, error, count } = await supabase
		.from('venue_wishlists')
		.select(`id, created_at, venues (${venueCardSelect})`, { count: 'exact' })
		.eq('user_id', user.id)
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (error) {
		console.error('wishlist list', error);
		return c.json({ error: error.message }, 500);
	}

	const rows = (data ?? []).map((row) => {
		const raw = row.venues as unknown;
		const venue = Array.isArray(raw) ? raw[0] ?? null : raw;
		return {
			id: row.id,
			saved_at: row.created_at,
			venue,
		};
	});

	return c.json({
		data: rows,
		meta: {
			total: count ?? 0,
			page,
			limit,
			totalPages: Math.ceil((count ?? 0) / limit),
		},
	});
});

wishlistRouter.post('/', authenticate, zValidator('json', addBodySchema), async (c) => {
	const user = c.var.user;
	const { venue_id } = c.req.valid('json');

	const { data: venue } = await supabase.from('venues').select('id').eq('id', venue_id).maybeSingle();
	if (!venue) {
		return c.json({ error: 'Venue not found' }, 404);
	}

	const { data: existing } = await supabase
		.from('venue_wishlists')
		.select('id')
		.eq('user_id', user.id)
		.eq('venue_id', venue_id)
		.maybeSingle();

	if (existing) {
		return c.json({ data: { venue_id, saved: true } }, 200);
	}

	const { data, error } = await supabase
		.from('venue_wishlists')
		.insert({ user_id: user.id, venue_id })
		.select('id, created_at')
		.single();

	if (error) {
		console.error('wishlist insert', error);
		const msg =
			error.code === '23503' ? 'Профайл олдсонгүй. Дахин нэвтэрнэ үү.' : error.message;
		return c.json({ error: msg }, 400);
	}

	return c.json({ data: { id: data.id, venue_id, saved: true } }, 201);
});

wishlistRouter.delete('/:venueId', authenticate, async (c) => {
	const user = c.var.user;
	const venueId = c.req.param('venueId');
	if (!z.string().uuid().safeParse(venueId).success) {
		return c.json({ error: 'Байршлын ID буруу байна' }, 400);
	}

	const { data, error } = await supabase
		.from('venue_wishlists')
		.delete()
		.eq('user_id', user.id)
		.eq('venue_id', venueId)
		.select('id')
		.maybeSingle();

	if (error) {
		console.error('wishlist delete', error);
		return c.json({ error: error.message }, 500);
	}

	if (!data) {
		return c.json({ error: 'Wishlist-д байхгүй байна' }, 404);
	}

	return c.json({ data: { removed: true, venue_id: venueId } }, 200);
});
