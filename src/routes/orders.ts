import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import { authenticate } from '../middleware/auth.js';
import { buildPackageSnapshot } from './venue-packages.js';
import { buildServiceSnapshot } from './services.js';
import {
	computeServiceUnitPrice,
	resolveServiceOptionSelections,
} from '../lib/service-options.js';
import { venueOnlyOrderPrice, venuePackageOrderPrice } from '../lib/venue-pricing.js';

export const ordersRouter = new Hono();

const orderLineDisplaySchema = {
	name: z.string(),
	providerLabel: z.string(),
	category: z.string(),
	categoryLabel: z.string(),
	image: z.string().optional().default(''),
	price: z.number().min(0),
	bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
};

const venueOrderItemSchema = z.object({
	itemType: z.literal('venue').optional(),
	venueId: z.string().uuid(),
	...orderLineDisplaySchema,
	guestCount: z.number().int().min(1),
	packageId: z.string().uuid().optional(),
});

const serviceOrderItemSchema = z.object({
	itemType: z.literal('service'),
	serviceId: z.string().uuid(),
	...orderLineDisplaySchema,
	quantity: z.coerce.number().int().min(1).default(1),
	selected_options: z.array(z.string().uuid()).optional().default([]),
});

const legacyVenueOrderItemSchema = z
	.object({
		venueId: z.string(),
		name: z.string(),
		providerLabel: z.string(),
		category: z.string(),
		categoryLabel: z.string(),
		image: z.string().optional().default(''),
		guestCount: z.number().int().min(1),
		price: z.number().min(0),
		bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
		packageId: z.string().uuid().optional(),
		serviceId: z.undefined().optional(),
	})
	.refine((i) => !i.serviceId, { message: 'serviceId not allowed on venue lines' });

const orderItemSchema = z.union([serviceOrderItemSchema, venueOrderItemSchema, legacyVenueOrderItemSchema]);

type OrderItemInput = z.infer<typeof orderItemSchema>;

function isServiceLine(item: OrderItemInput): item is z.infer<typeof serviceOrderItemSchema> {
	return 'itemType' in item && item.itemType === 'service';
}

async function resolveServiceOrderItem(
	item: z.infer<typeof serviceOrderItemSchema>,
): Promise<{ item: Record<string, unknown>; error?: string }> {
	const { data: svc, error: svcErr } = await supabase
		.from('provider_services')
		.select('id, slug, name, kind, price_flat, status')
		.eq('id', item.serviceId)
		.eq('status', 'enabled')
		.maybeSingle();

	if (svcErr || !svc) {
		return { item: { ...item }, error: 'Сонгосон үйлчилгээ олдсонгүй эсвэл идэвхгүй байна.' };
	}

	const selectedOptionIds = item.selected_options ?? [];
	const resolvedOptions = await resolveServiceOptionSelections(item.serviceId, selectedOptionIds);
	if (!resolvedOptions.ok) {
		return { item: { ...item }, error: resolvedOptions.error };
	}

	const unitPrice = computeServiceUnitPrice(
		Number(svc.price_flat),
		resolvedOptions.optionsPriceSum,
		resolvedOptions.hasOptionGroups,
		resolvedOptions.selections.length > 0,
	);
	const linePrice = unitPrice * item.quantity;
	const snapshot = buildServiceSnapshot(
		svc as Record<string, unknown>,
		item.quantity,
		resolvedOptions.selections,
		unitPrice,
	);

	const line: Record<string, unknown> = {
		...item,
		itemType: 'service',
		price: linePrice,
		selected_options: selectedOptionIds,
		service_snapshot: snapshot,
	};

	return { item: line };
}

async function resolveVenueOrderItemWithPackage(
	item: z.infer<typeof venueOrderItemSchema> | z.infer<typeof legacyVenueOrderItemSchema>,
): Promise<{ item: Record<string, unknown>; error?: string }> {
	const venueId = item.venueId;
	const packageId = 'packageId' in item ? item.packageId : undefined;

	if (!z.string().uuid().safeParse(venueId).success) {
		return { item: { ...item, itemType: 'venue' }, error: 'Байршлын ID буруу байна.' };
	}

	const { data: venue, error: venueErr } = await supabase
		.from('venues')
		.select('id, price_flat, status')
		.eq('id', venueId)
		.eq('status', 'enabled')
		.maybeSingle();

	if (venueErr || !venue) {
		return { item: { ...item, itemType: 'venue' }, error: 'Байршил олдсонгүй эсвэл идэвхгүй байна.' };
	}

	if (!packageId) {
		return {
			item: {
				...item,
				itemType: 'venue',
				price: venueOnlyOrderPrice(Number(venue.price_flat)),
				pricing_mode: 'venue_flat',
			},
		};
	}

	if (!z.string().uuid().safeParse(packageId).success) {
		return { item: { ...item, itemType: 'venue' }, error: 'Багц эсвэл байршлын ID буруу байна.' };
	}

	const { data: pkg, error: pkgErr } = await supabase
		.from('venue_event_packages')
		.select(
			'id, venue_id, slug, name, short_description, price_per_person, guests_min, guests_max, is_active, venue_package_services (kind, title, quantity, is_included, sort_order)',
		)
		.eq('id', packageId)
		.eq('venue_id', venueId)
		.eq('is_active', true)
		.maybeSingle();

	if (pkgErr || !pkg) {
		return { item: { ...item, itemType: 'venue' }, error: 'Сонгосон багц олдсонгүй эсвэл идэвхгүй байна.' };
	}

	if (pkg.guests_min != null && item.guestCount < pkg.guests_min) {
		return { item: { ...item, itemType: 'venue' }, error: `Зочдын тоо дор хаяж ${pkg.guests_min} байх ёстой.` };
	}
	if (pkg.guests_max != null && item.guestCount > pkg.guests_max) {
		return { item: { ...item, itemType: 'venue' }, error: `Зочдын тоо ихдээ ${pkg.guests_max} байх ёстой.` };
	}

	const snapshot = buildPackageSnapshot(pkg as Record<string, unknown>, item.guestCount);

	const line: Record<string, unknown> = {
		...item,
		itemType: 'venue',
		price: venuePackageOrderPrice(Number(pkg.price_per_person), item.guestCount),
		pricing_mode: 'package_per_person',
		packageId: pkg.id,
		package_slug: pkg.slug,
		package_snapshot: snapshot,
	};

	return { item: line };
}

async function resolveOrderItem(item: OrderItemInput): Promise<{ item: Record<string, unknown>; error?: string }> {
	if (isServiceLine(item)) {
		return resolveServiceOrderItem(item);
	}
	return resolveVenueOrderItemWithPackage(item);
}

export async function resolveOrderLineItems(
	rawItems: Record<string, unknown>[],
): Promise<{ resolved: Record<string, unknown>[]; subtotal: number } | { error: string }> {
	const resolved: Record<string, unknown>[] = [];
	for (const raw of rawItems) {
		const parsed = orderItemSchema.safeParse(raw);
		if (!parsed.success) {
			return { error: 'Мэдээлэл буруу байна. Формоо шалгана уу.' };
		}
		const { item, error: resolveErr } = await resolveOrderItem(parsed.data);
		if (resolveErr) return { error: resolveErr };
		resolved.push(item);
	}
	const subtotal = resolved.reduce((s, i) => s + Number(i.price), 0);
	return { resolved, subtotal };
}

const createOrderSchema = z.object({
	form: z.object({
		fullName: z.string().min(1),
		email: z.string().email(),
		phone: z.string().min(1),
		paymentMethod: z.string(),
		notes: z.string().optional(),
	}),
	items: z.array(orderItemSchema).min(1),
	subtotal: z.number().min(0),
	total: z.number().min(0),
});

const orderListQuerySchema = z.object({
	page: z.coerce.number().min(1).default(1),
	limit: z.coerce.number().min(1).max(100).default(20),
	status: z.string().min(1).optional(),
});

const orderIdParamSchema = z.object({
	id: z.string().uuid(),
});

ordersRouter.post('/make-order', authenticate, async (c) => {
	const user = c.var.user;

	const body = await c.req.json();
	const parsed = createOrderSchema.safeParse(body);

	if (!parsed.success) {
		return c.json({ error: 'Мэдээлэл буруу байна. Формоо шалгана уу.' }, 400);
	}

	const { form, items, subtotal, total } = parsed.data;

	const resolved = await resolveOrderLineItems(items as Record<string, unknown>[]);
	if ('error' in resolved) return c.json({ error: resolved.error }, 400);
	const resolvedItems = resolved.resolved;
	const recomputed = resolved.subtotal;
	if (recomputed !== subtotal || total !== subtotal) {
		return c.json({ error: 'Дүн тохирохгүй байна. Сагсаа дахин ачаална уу.' }, 400);
	}

	const { data, error } = await supabase
		.from('orders')
		.insert({
			user_id: user.id,
			customer_name: form.fullName.trim(),
			customer_email: form.email.trim().toLowerCase(),
			customer_phone: form.phone.trim(),
			payment_method: form.paymentMethod,
			notes: form.notes?.trim() || null,
			items: resolvedItems,
			subtotal,
			total,
			status: 'pending',
		})
		.select('*')
		.single();

	if (error) {
		console.error('orders insert', error);
		return c.json({ error: 'Захиалга хадгалагдаагүй байна.' }, 500);
	}

	return c.json({ data: { orderId: data.id, order: data } }, 201);
});

ordersRouter.get('/', authenticate, zValidator('query', orderListQuerySchema), async (c) => {
	const user = c.var.user;
	const { page, limit, status } = c.req.valid('query');
	const offset = (page - 1) * limit;

	let query = supabase
		.from('orders')
		.select('id, status, total, subtotal, created_at, customer_name, payment_method', {
			count: 'exact',
		})
		.eq('user_id', user.id)
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (status) query = query.eq('status', status);

	const { data, error, count } = await query;

	if (error) {
		console.error('orders list', error);
		return c.json({ error: 'Захиалгууд ачааллаагүй байна.' }, 500);
	}

	const totalCount = count ?? 0;

	return c.json({
		data: data ?? [],
		meta: {
			total: totalCount,
			page,
			limit,
			totalPages: Math.ceil(totalCount / limit),
		},
	});
});

ordersRouter.get('/:id', authenticate, zValidator('param', orderIdParamSchema), async (c) => {
	const orderId = c.req.valid('param').id;
	const user = c.var.user;

	const { data, error } = await supabase
		.from('orders')
		.select('*')
		.eq('id', orderId)
		.maybeSingle();

	if (error) {
		console.error('orders detail', error);
		return c.json({ error: 'Захиалга ачааллаагүй байна.' }, 500);
	}
	if (!data) return c.json({ error: 'Order not found' }, 404);

	if (user.role === 'admin') {
		return c.json({ data });
	}

	if (data.user_id !== user.id) {
		return c.json({ error: 'Unauthorized' }, 403);
	}

	return c.json({ data });
});
