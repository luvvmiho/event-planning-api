import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import {
	buildEventPlanSummary,
	loadEventPlanForUser,
	type EventPlanRow,
} from '../lib/event-plan-build.js';
import { authenticate } from '../middleware/auth.js';
import { resolveOrderLineItems } from './orders.js';

export const eventPlansRouter = new Hono();

eventPlansRouter.use('*', authenticate);

const planIdParam = z.object({ id: z.string().uuid() });
const lineIdParam = z.object({ id: z.string().uuid(), lineId: z.string().uuid() });

const listQuerySchema = z.object({
	page: z.coerce.number().min(1).default(1),
	limit: z.coerce.number().min(1).max(50).default(20),
	status: z.enum(['draft', 'archived']).optional(),
});

const createPlanSchema = z.object({
	name: z.string().trim().min(1).max(200).optional(),
	budget: z.coerce.number().int().min(0),
	event_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
	guest_count: z.coerce.number().int().min(1).optional(),
	notes: z.preprocess((v) => (v === '' || v === null ? undefined : v), z.string().trim().max(2000).optional()),
});

const patchPlanSchema = createPlanSchema.partial().refine(
	(v) =>
		v.name !== undefined ||
		v.budget !== undefined ||
		v.event_date !== undefined ||
		v.guest_count !== undefined ||
		v.notes !== undefined,
	{ message: 'Шинэчлэх талбар оруулна уу' },
);

const setVenueSchema = z.object({
	venue_id: z.string().uuid(),
	venue_package_id: z.string().uuid().optional(),
	venue_guest_count: z.coerce.number().int().min(1).optional(),
	venue_booking_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});

const addServiceSchema = z.object({
	provider_service_id: z.string().uuid(),
	quantity: z.coerce.number().int().min(1).default(1),
	sort_order: z.coerce.number().int().optional().default(0),
});

const patchServiceLineSchema = z.object({
	quantity: z.coerce.number().int().min(1),
});

const checkoutSchema = z.object({
	fullName: z.string().min(1),
	email: z.string().email(),
	phone: z.string().min(1),
	paymentMethod: z.string(),
	notes: z.string().optional(),
});

async function planResponse(plan: EventPlanRow) {
	const summary = await buildEventPlanSummary(plan);
	return { ...plan, ...summary };
}

eventPlansRouter.get('/', zValidator('query', listQuerySchema), async (c) => {
	const user = c.var.user;
	const { page, limit, status } = c.req.valid('query');
	const offset = (page - 1) * limit;

	let q = supabase
		.from('event_plans')
		.select('id, name, budget, event_date, guest_count, status, venue_id, created_at, updated_at', {
			count: 'exact',
		})
		.eq('user_id', user.id)
		.order('updated_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (status) q = q.eq('status', status);

	const { data, error, count } = await q;
	if (error) return c.json({ error: error.message }, 500);

	const rows = await Promise.all(
		(data ?? []).map(async (p) => {
			const full = await supabase.from('event_plans').select('*').eq('id', p.id).single();
			if (!full.data) return { ...p, estimated_total: 0, remaining_budget: p.budget, over_budget: false };
			const s = await buildEventPlanSummary(full.data as EventPlanRow);
			return {
				...p,
				estimated_total: s.estimated_total,
				remaining_budget: s.remaining_budget,
				over_budget: s.over_budget,
				has_venue: !!p.venue_id,
			};
		}),
	);

	return c.json({
		data: rows,
		meta: { total: count ?? 0, page, limit, totalPages: Math.ceil((count ?? 0) / limit) },
	});
});

eventPlansRouter.post('/', zValidator('json', createPlanSchema), async (c) => {
	const user = c.var.user;
	const body = c.req.valid('json');

	const { data, error } = await supabase
		.from('event_plans')
		.insert({
			user_id: user.id,
			name: body.name?.trim() ?? 'Миний арга хэмжээ',
			budget: body.budget,
			event_date: body.event_date ?? null,
			guest_count: body.guest_count ?? null,
			notes: body.notes ?? null,
			updated_at: new Date().toISOString(),
		})
		.select('*')
		.single();

	if (error) return c.json({ error: error.message }, 400);
	return c.json({ data: await planResponse(data as EventPlanRow) }, 201);
});

eventPlansRouter.get('/:id', zValidator('param', planIdParam), async (c) => {
	const { id } = c.req.valid('param');
	const user = c.var.user;
	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);
	return c.json({ data: await planResponse(plan) });
});

eventPlansRouter.patch('/:id', zValidator('param', planIdParam), zValidator('json', patchPlanSchema), async (c) => {
	const { id } = c.req.valid('param');
	const user = c.var.user;
	const body = c.req.valid('json');

	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);

	const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
	if (body.name !== undefined) updates.name = body.name.trim();
	if (body.budget !== undefined) updates.budget = body.budget;
	if (body.event_date !== undefined) updates.event_date = body.event_date;
	if (body.guest_count !== undefined) updates.guest_count = body.guest_count;
	if (body.notes !== undefined) updates.notes = body.notes;

	const { data, error } = await supabase.from('event_plans').update(updates).eq('id', id).select('*').single();
	if (error) return c.json({ error: error.message }, 400);
	return c.json({ data: await planResponse(data as EventPlanRow) });
});

eventPlansRouter.delete('/:id', zValidator('param', planIdParam), async (c) => {
	const { id } = c.req.valid('param');
	const user = c.var.user;

	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);

	const { error } = await supabase.from('event_plans').delete().eq('id', id);
	if (error) return c.json({ error: error.message }, 400);
	return c.json({ data: { deleted: true, id } });
});

/** Choose venue (and optional package) for the plan. */
eventPlansRouter.put('/:id/venue', zValidator('param', planIdParam), zValidator('json', setVenueSchema), async (c) => {
	const { id } = c.req.valid('param');
	const user = c.var.user;
	const body = c.req.valid('json');

	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);

	const { data: venue } = await supabase
		.from('venues')
		.select('id, status')
		.eq('id', body.venue_id)
		.eq('status', 'published')
		.maybeSingle();
	if (!venue) return c.json({ error: 'Байршил олдсонгүй эсвэл идэвхгүй байна' }, 400);

	if (body.venue_package_id) {
		const { data: pkg } = await supabase
			.from('venue_event_packages')
			.select('id, guests_min, guests_max')
			.eq('id', body.venue_package_id)
			.eq('venue_id', body.venue_id)
			.eq('is_active', true)
			.maybeSingle();
		if (!pkg) return c.json({ error: 'Багц олдсонгүй эсвэл идэвхгүй байна' }, 400);

		const guests = body.venue_guest_count ?? plan.guest_count ?? 1;
		if (pkg.guests_min != null && guests < pkg.guests_min) {
			return c.json({ error: `Зочдын тоо дор хаяж ${pkg.guests_min} байх ёстой` }, 400);
		}
		if (pkg.guests_max != null && guests > pkg.guests_max) {
			return c.json({ error: `Зочдын тоо ихдээ ${pkg.guests_max} байх ёстой` }, 400);
		}
	}

	const { data, error } = await supabase
		.from('event_plans')
		.update({
			venue_id: body.venue_id,
			venue_package_id: body.venue_package_id ?? null,
			venue_guest_count: body.venue_guest_count ?? plan.guest_count ?? null,
			venue_booking_date: body.venue_booking_date ?? plan.event_date ?? null,
			updated_at: new Date().toISOString(),
		})
		.eq('id', id)
		.select('*')
		.single();

	if (error) return c.json({ error: error.message }, 400);
	return c.json({ data: await planResponse(data as EventPlanRow) });
});

eventPlansRouter.delete('/:id/venue', zValidator('param', planIdParam), async (c) => {
	const { id } = c.req.valid('param');
	const user = c.var.user;

	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);

	const { data, error } = await supabase
		.from('event_plans')
		.update({
			venue_id: null,
			venue_package_id: null,
			venue_booking_date: null,
			venue_guest_count: null,
			updated_at: new Date().toISOString(),
		})
		.eq('id', id)
		.select('*')
		.single();

	if (error) return c.json({ error: error.message }, 400);
	return c.json({ data: await planResponse(data as EventPlanRow) });
});

eventPlansRouter.post(
	'/:id/services',
	zValidator('param', planIdParam),
	zValidator('json', addServiceSchema),
	async (c) => {
		const { id } = c.req.valid('param');
		const user = c.var.user;
		const body = c.req.valid('json');

		const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
		if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
		if (!plan) return c.json({ error: 'Event plan not found' }, 404);

		const { data: svc } = await supabase
			.from('provider_services')
			.select('id')
			.eq('id', body.provider_service_id)
			.eq('status', 'published')
			.maybeSingle();
		if (!svc) return c.json({ error: 'Үйлчилгээ олдсонгүй эсвэл идэвхгүй байна' }, 400);

		const { error } = await supabase.from('event_plan_services').insert({
			plan_id: id,
			provider_service_id: body.provider_service_id,
			quantity: body.quantity,
			sort_order: body.sort_order,
		});

		if (error) {
			if (error.code === '23505') return c.json({ error: 'Үйлчилгээ аль хэдийн нэмэгдсэн' }, 409);
			return c.json({ error: error.message }, 400);
		}

		await supabase.from('event_plans').update({ updated_at: new Date().toISOString() }).eq('id', id);
		const { plan: updated } = await loadEventPlanForUser(id, user.id);
		return c.json({ data: await planResponse(updated!) }, 201);
	},
);

eventPlansRouter.patch(
	'/:id/services/:lineId',
	zValidator('param', lineIdParam),
	zValidator('json', patchServiceLineSchema),
	async (c) => {
		const { id, lineId } = c.req.valid('param');
		const user = c.var.user;
		const { quantity } = c.req.valid('json');

		const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
		if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
		if (!plan) return c.json({ error: 'Event plan not found' }, 404);

		const { data: line } = await supabase
			.from('event_plan_services')
			.select('id')
			.eq('id', lineId)
			.eq('plan_id', id)
			.maybeSingle();
		if (!line) return c.json({ error: 'Line not found' }, 404);

		await supabase.from('event_plan_services').update({ quantity }).eq('id', lineId);
		await supabase.from('event_plans').update({ updated_at: new Date().toISOString() }).eq('id', id);

		const { plan: updated } = await loadEventPlanForUser(id, user.id);
		return c.json({ data: await planResponse(updated!) });
	},
);

eventPlansRouter.delete('/:id/services/:lineId', zValidator('param', lineIdParam), async (c) => {
	const { id, lineId } = c.req.valid('param');
	const user = c.var.user;

	const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
	if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
	if (!plan) return c.json({ error: 'Event plan not found' }, 404);

	await supabase.from('event_plan_services').delete().eq('id', lineId).eq('plan_id', id);
	await supabase.from('event_plans').update({ updated_at: new Date().toISOString() }).eq('id', id);

	const { plan: updated } = await loadEventPlanForUser(id, user.id);
	return c.json({ data: await planResponse(updated!) });
});

/** Convert plan → order (same rules as POST /orders/make-order). */
eventPlansRouter.post(
	'/:id/checkout',
	zValidator('param', planIdParam),
	zValidator('json', checkoutSchema),
	async (c) => {
		const { id } = c.req.valid('param');
		const user = c.var.user;
		const form = c.req.valid('json');

		const { plan, forbidden } = await loadEventPlanForUser(id, user.id);
		if (forbidden) return c.json({ error: 'Unauthorized' }, 403);
		if (!plan) return c.json({ error: 'Event plan not found' }, 404);

		const summary = await buildEventPlanSummary(plan);
		if (!summary.venue && summary.services.length === 0) {
			return c.json({ error: 'Байршил эсвэл үйлчилгээ сонгоно уу' }, 400);
		}

		const items: Record<string, unknown>[] = [];

		if (summary.venue) {
			const { data: venue } = await supabase
				.from('venues')
				.select('id, name, slug, image_url, price_per_person, categories(slug, name)')
				.eq('id', summary.venue.venue_id)
				.single();

			const cat = venue?.categories as { slug?: string; name?: string } | { slug?: string; name?: string }[] | null;
			const category = Array.isArray(cat) ? cat[0] : cat;

			items.push({
				itemType: 'venue',
				venueId: summary.venue.venue_id,
				name: summary.venue.venue_name,
				providerLabel: summary.venue.venue_name,
				category: category?.slug ?? 'venue',
				categoryLabel: category?.name ?? 'Байршил',
				image: venue?.image_url ?? '',
				guestCount: summary.venue.guest_count,
				price: summary.venue.estimated_price,
				bookingDate: summary.venue.booking_date ?? plan.event_date ?? new Date().toISOString().slice(0, 10),
				...(summary.venue.package_id ? { packageId: summary.venue.package_id } : {}),
			});
		}

		for (const line of summary.services) {
			items.push({
				itemType: 'service',
				serviceId: line.provider_service_id,
				name: line.service.name,
				providerLabel: line.service.name,
				category: line.service.kind,
				categoryLabel: line.service.kind,
				image: line.service.image_url ?? '',
				quantity: line.quantity,
				price: line.estimated_price,
				bookingDate: plan.event_date ?? new Date().toISOString().slice(0, 10),
			});
		}

		const resolved = await resolveOrderLineItems(items);
		if ('error' in resolved) return c.json({ error: resolved.error }, 400);

		const subtotal = resolved.subtotal;
		const total = subtotal;

		const { data: order, error } = await supabase
			.from('orders')
			.insert({
				user_id: user.id,
				customer_name: form.fullName.trim(),
				customer_email: form.email.trim().toLowerCase(),
				customer_phone: form.phone.trim(),
				payment_method: form.paymentMethod,
				notes: form.notes?.trim() || plan.notes || null,
				items: resolved.resolved,
				subtotal,
				total,
				status: 'pending',
			})
			.select('*')
			.single();

		if (error) {
			console.error('event plan checkout', error);
			return c.json({ error: 'Захиалга хадгалагдаагүй байна' }, 500);
		}

		return c.json({
			data: {
				event_plan_id: id,
				orderId: order.id,
				order,
				summary: {
					budget: summary.budget,
					estimated_total: summary.estimated_total,
					over_budget: summary.over_budget,
					mixed_providers: summary.mixed_providers,
				},
			},
		}, 201);
	},
);
