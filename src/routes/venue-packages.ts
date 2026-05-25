import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { assertProviderAccess, authenticate, requireProvider } from '../middleware/auth.js';
import { supabase } from '../lib/supabase.js';
import type { AuthUser } from '../types/index.js';

const PACKAGE_SERVICE_KINDS = [
	'food',
	'cake',
	'car',
	'photoshoot',
	'entertainment',
	'decoration',
	'catering',
	'staff',
	'other',
] as const;

const PACKAGE_SERVICE_SELECT =
	'id, package_id, kind, title, description, quantity, is_included, sort_order, provider_service_id, provider_services (id, slug, name, kind, price_flat, image_url)';

const slugifyAscii = (input: string): string => {
	const s = input
		.toLowerCase()
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 72);
	return s || `pkg-${randomUUID().slice(0, 8)}`;
};

export const generateUniquePackageSlug = async (venueId: string, baseName: string): Promise<string> => {
	let base = slugifyAscii(baseName);
	if (base.length < 2) base = `pkg-${randomUUID().slice(0, 8)}`;

	let candidate = base;
	for (let attempt = 0; attempt < 24; attempt++) {
		const { data: clash } = await supabase
			.from('venue_event_packages')
			.select('id')
			.eq('venue_id', venueId)
			.eq('slug', candidate)
			.maybeSingle();
		if (!clash) return candidate;
		candidate = `${base}-${randomUUID().slice(0, 8)}`;
	}
	return `${base}-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
};

async function assertVenueWriteAccess(user: AuthUser, venueId: string): Promise<void> {
	await assertProviderAccess(user);
	let q = supabase.from('venues').select('provider_id').eq('id', venueId);
	if (user.role !== 'admin') {
		q = q.eq('provider_id', user.id);
	}
	const { data, error } = await q.maybeSingle();
	if (error || !data) throw new Error('VENUE_NA');
	if (user.role !== 'admin' && data.provider_id !== user.id) throw new Error('VENUE_NA');
}

type PackageSvc = {
	kind: unknown;
	title: unknown;
	quantity: unknown;
	is_included: unknown;
	sort_order: unknown;
	provider_service_id?: unknown;
	provider_services?: Record<string, unknown> | null;
};

const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);

const packageServiceSchema = z
	.object({
		provider_service_id: z.string().uuid().optional(),
		kind: z.enum(PACKAGE_SERVICE_KINDS).optional(),
		title: z.string().trim().min(1).optional(),
		description: z.preprocess(
			(v) => (v === '' || v === undefined ? undefined : v),
			z.string().trim().max(2000).optional(),
		),
		quantity: z.coerce.number().int().min(1).default(1),
		is_included: z.boolean().default(true),
		sort_order: z.coerce.number().int().default(0),
	})
	.superRefine((s, ctx) => {
		if (s.provider_service_id) return;
		if (!s.kind) {
			ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'kind required without provider_service_id', path: ['kind'] });
		}
		if (!s.title?.trim()) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'title required without provider_service_id',
				path: ['title'],
			});
		}
	});

type PackageServiceInput = z.infer<typeof packageServiceSchema>;

type ResolvedPackageLine = {
	package_id: string;
	kind: string;
	title: string;
	description: string | null;
	quantity: number;
	is_included: boolean;
	sort_order: number;
	provider_service_id: string | null;
};

const providerKindToPackageKind = (kind: string): (typeof PACKAGE_SERVICE_KINDS)[number] => {
	if ((PACKAGE_SERVICE_KINDS as readonly string[]).includes(kind)) {
		return kind as (typeof PACKAGE_SERVICE_KINDS)[number];
	}
	return 'other';
};

async function getVenueProviderId(venueId: string): Promise<string | null> {
	const { data } = await supabase.from('venues').select('provider_id').eq('id', venueId).maybeSingle();
	return data?.provider_id ?? null;
}

export async function resolvePackageServiceLines(
	venueId: string,
	packageId: string,
	services: PackageServiceInput[],
): Promise<
	{ ok: true; lines: ResolvedPackageLine[] } | { ok: false; error: string; statusCode: 400 | 403 | 404 | 500 }
> {
	const providerId = await getVenueProviderId(venueId);
	if (!providerId) {
		return { ok: false, error: 'Байршлын provider олдсонгүй', statusCode: 400 };
	}

	const lines: ResolvedPackageLine[] = [];

	for (const s of services) {
		if (s.provider_service_id) {
			const { data: ps, error } = await supabase
				.from('provider_services')
				.select('id, provider_id, name, kind, short_description')
				.eq('id', s.provider_service_id)
				.maybeSingle();

			if (error || !ps) {
				return { ok: false, error: 'Үйлчилгээ олдсонгүй', statusCode: 400 };
			}
			if (ps.provider_id !== providerId) {
				return {
					ok: false,
					error: 'Зөвхөн өөрийн үйлчилгээг багцад нэмнэ үү',
					statusCode: 403,
				};
			}

			lines.push({
				package_id: packageId,
				kind: providerKindToPackageKind(String(ps.kind)),
				title: ps.name.trim(),
				description: s.description ?? ps.short_description ?? null,
				quantity: s.quantity,
				is_included: s.is_included,
				sort_order: s.sort_order,
				provider_service_id: ps.id,
			});
		} else {
			lines.push({
				package_id: packageId,
				kind: s.kind!,
				title: s.title!.trim(),
				description: s.description ?? null,
				quantity: s.quantity,
				is_included: s.is_included,
				sort_order: s.sort_order,
				provider_service_id: null,
			});
		}
	}

	return { ok: true, lines };
}

export const createPackageBodySchema = z.object({
	slug: z.preprocess(
		(v) => (v === '' ? undefined : v),
		z
			.string()
			.trim()
			.regex(/^[a-z0-9-]+$/, 'latin slug only')
			.min(2)
			.max(96)
			.optional(),
	),
	name: z.string().trim().min(2),
	short_description: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(1000).optional()),
	price_per_person: z.coerce.number().int().min(0),
	guests_min: z.union([z.coerce.number().int().min(1), z.literal(null)]).optional(),
	guests_max: z.union([z.coerce.number().int().min(1), z.literal(null)]).optional(),
	is_active: z.boolean().optional().default(true),
	sort_order: z.coerce.number().int().optional().default(0),
	image_url: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
	images: z.array(z.string().trim().max(2000)).max(20).optional(),
	services: z.array(packageServiceSchema).optional().default([]),
});

const patchPackageBodySchema = z
	.object({
		slug: z
			.string()
			.trim()
			.regex(/^[a-z0-9-]+$/)
			.min(2)
			.max(96)
			.optional(),
		name: z.string().trim().min(2).optional(),
		short_description: z.union([z.string().trim().max(1000), z.literal(null)]).optional(),
		price_per_person: z.coerce.number().int().min(0).optional(),
		guests_min: z.union([z.coerce.number().int().min(1), z.literal(null)]).optional(),
		guests_max: z.union([z.coerce.number().int().min(1), z.literal(null)]).optional(),
		is_active: z.boolean().optional(),
		sort_order: z.coerce.number().int().optional(),
		image_url: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
		images: z.array(z.string().trim().max(2000)).max(20).optional(),
		services: z.array(packageServiceSchema).optional(),
	})
	.refine(
		(body) =>
			body.slug !== undefined ||
			body.name !== undefined ||
			body.short_description !== undefined ||
			body.price_per_person !== undefined ||
			body.guests_min !== undefined ||
			body.guests_max !== undefined ||
			body.is_active !== undefined ||
			body.sort_order !== undefined ||
			body.image_url !== undefined ||
			body.images !== undefined ||
			body.services !== undefined,
		{ message: 'Шинэчлэх талбар оруулна уу' },
	);

const PACKAGE_SELECT_PUBLIC =
	'id, venue_id, slug, name, short_description, price_per_person, guests_min, guests_max, sort_order, image_url, images';
const PACKAGE_SELECT_DETAIL = PACKAGE_SELECT_PUBLIC + ', is_active, created_at, updated_at';

export type CreatePackageBody = z.infer<typeof createPackageBodySchema>;

export const upsertEventPackageInputSchema = createPackageBodySchema.extend({
	id: z.string().uuid().optional(),
});

export type UpsertEventPackageInput = z.infer<typeof upsertEventPackageInputSchema>;

export async function updateVenuePackageRecord(
	packageId: string,
	body: CreatePackageBody,
): Promise<
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; error: string; statusCode: 400 | 403 | 404 | 409 | 500 }
> {
	const updates: Record<string, unknown> = {
		name: body.name.trim(),
		short_description: body.short_description?.trim() ?? null,
		price_per_person: body.price_per_person,
		guests_min: body.guests_min === null ? null : body.guests_min,
		guests_max: body.guests_max === null ? null : body.guests_max,
		is_active: body.is_active,
		sort_order: body.sort_order,
		image_url: body.image_url ?? null,
		images: body.images ?? [],
		updated_at: new Date().toISOString(),
	};
	if (body.slug != null && body.slug.trim().length > 0) {
		updates.slug = body.slug.trim();
	}

	const { error: upErr } = await supabase.from('venue_event_packages').update(updates).eq('id', packageId);
	if (upErr) {
		if (upErr.code === '23505') {
			return { ok: false, error: 'Slug already exists for this venue', statusCode: 409 };
		}
		return { ok: false, error: upErr.message, statusCode: 400 };
	}

	const { error: delErr } = await supabase.from('venue_package_services').delete().eq('package_id', packageId);
	if (delErr) return { ok: false, error: delErr.message, statusCode: 400 };

	const { data: pkgVenue } = await supabase
		.from('venue_event_packages')
		.select('venue_id')
		.eq('id', packageId)
		.maybeSingle();
	if (!pkgVenue) return { ok: false, error: 'Багц олдсонгүй', statusCode: 404 };

	if (body.services.length > 0) {
		const resolved = await resolvePackageServiceLines(pkgVenue.venue_id, packageId, body.services);
		if (!resolved.ok) return resolved;
		const { error: lineErr } = await supabase.from('venue_package_services').insert(resolved.lines);
		if (lineErr) return { ok: false, error: lineErr.message, statusCode: 400 };
	}

	const { data: full } = await supabase
		.from('venue_event_packages')
		.select(`${PACKAGE_SELECT_DETAIL}, venue_package_services (${PACKAGE_SERVICE_SELECT})`)
		.eq('id', packageId)
		.maybeSingle();

	if (!full) return { ok: false, error: 'Багц олдсонгүй', statusCode: 404 };
	return { ok: true, data: full as Record<string, unknown> };
}

export async function syncVenueEventPackages(
	venueId: string,
	packages: UpsertEventPackageInput[],
): Promise<
	| { ok: true; data: Record<string, unknown>[] }
	| { ok: false; error: string; statusCode: 400 | 403 | 404 | 409 | 500 }
> {
	if (packages.length > 30) {
		return { ok: false, error: 'Хамгийн ихдээ 30 багц байна', statusCode: 400 };
	}

	const { data: existing, error: listErr } = await supabase
		.from('venue_event_packages')
		.select('id')
		.eq('venue_id', venueId);

	if (listErr) return { ok: false, error: listErr.message, statusCode: 500 };

	const existingIds = new Set((existing ?? []).map((r) => String(r.id)));
	const keptIds = new Set<string>();
	const results: Record<string, unknown>[] = [];

	for (const pkg of packages) {
		const { id, ...createBody } = pkg;
		if (id) {
			if (!existingIds.has(id)) {
				return { ok: false, error: 'Багц энэ байршилд олдсонгүй', statusCode: 400 };
			}
			const updated = await updateVenuePackageRecord(id, createBody);
			if (!updated.ok) return updated;
			keptIds.add(id);
			results.push(updated.data);
		} else {
			const created = await persistVenuePackage(venueId, createBody);
			if (!created.ok) return created;
			const newId = String((created.data as { id: string }).id);
			keptIds.add(newId);
			results.push(created.data);
		}
	}

	const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
	if (toDelete.length > 0) {
		const { error: delErr } = await supabase.from('venue_event_packages').delete().in('id', toDelete);
		if (delErr) return { ok: false, error: delErr.message, statusCode: 400 };
	}

	return { ok: true, data: results };
}

export async function persistVenuePackage(
	venueId: string,
	body: CreatePackageBody,
): Promise<
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; error: string; statusCode: 400 | 403 | 404 | 409 | 500 }
> {
	const slug =
		body.slug != null && body.slug.trim().length > 0
			? body.slug.trim()
			: await generateUniquePackageSlug(venueId, body.name);

	const row = {
		venue_id: venueId,
		slug,
		name: body.name.trim(),
		short_description: body.short_description?.trim() ?? null,
		price_per_person: body.price_per_person,
		guests_min: body.guests_min === null ? null : body.guests_min,
		guests_max: body.guests_max === null ? null : body.guests_max,
		is_active: body.is_active,
		sort_order: body.sort_order,
		image_url: body.image_url ?? null,
		images: body.images ?? [],
		updated_at: new Date().toISOString(),
	};

	const { data: pkg, error: insErr } = await supabase
		.from('venue_event_packages')
		.insert(row)
		.select(PACKAGE_SELECT_DETAIL)
		.single();

	if (insErr) {
		if (insErr.code === '23505') {
			return {
				ok: false,
				error: 'Slug already exists for this venue',
				statusCode: 409,
			};
		}
		return { ok: false, error: insErr.message, statusCode: 400 };
	}
	if (!pkg || typeof pkg !== 'object' || !('id' in pkg)) {
		return { ok: false, error: 'Багц хадгалагдаагүй байна.', statusCode: 500 };
	}
	const newPkgId = String((pkg as { id: string }).id);

	if (body.services.length > 0) {
		const resolved = await resolvePackageServiceLines(venueId, newPkgId, body.services);
		if (!resolved.ok) {
			await supabase.from('venue_event_packages').delete().eq('id', newPkgId);
			return resolved;
		}
		const { error: lineErr } = await supabase.from('venue_package_services').insert(resolved.lines);
		if (lineErr) {
			await supabase.from('venue_event_packages').delete().eq('id', newPkgId);
			return { ok: false, error: lineErr.message, statusCode: 400 };
		}
	}

	const { data: full, error: loadErr } = await supabase
		.from('venue_event_packages')
		.select(`${PACKAGE_SELECT_DETAIL}, venue_package_services (${PACKAGE_SERVICE_SELECT})`)
		.eq('id', newPkgId)
		.maybeSingle();

	if (loadErr || !full) {
		return { ok: true, data: pkg as Record<string, unknown> };
	}
	return { ok: true, data: full as Record<string, unknown> };
}

export const venuePackagesRouter = new Hono();

venuePackagesRouter.get(
	'/:id/event-packages/manage',
	authenticate,
	requireProvider,
	async (c) => {
		const vid = c.req.param('id');
		if (!z.string().uuid().safeParse(vid).success) {
			return c.json({ error: 'Байршлын ID буруу байна' }, 400);
		}
		const user = c.var.user;
		try {
			await assertVenueWriteAccess(user, vid);
		} catch {
			return c.json({ error: 'Venue not found or unauthorized' }, 403);
		}

		const { data, error } = await supabase
			.from('venue_event_packages')
			.select(`${PACKAGE_SELECT_DETAIL}, venue_package_services (${PACKAGE_SERVICE_SELECT})`)
			.eq('venue_id', vid)
			.order('sort_order', { ascending: true })
			.order('created_at', { ascending: false });

		if (error) return c.json({ error: error.message }, 500);
		return c.json({ data: data ?? [] });
	},
);

venuePackagesRouter.post(
	'/:id/event-packages',
	authenticate,
	requireProvider,
	zValidator('json', createPackageBodySchema),
	async (c) => {
		const vid = c.req.param('id');
		if (!z.string().uuid().safeParse(vid).success) {
			return c.json({ error: 'Байршлын ID буруу байна' }, 400);
		}
		const user = c.var.user;
		try {
			await assertVenueWriteAccess(user, vid);
		} catch {
			return c.json({ error: 'Venue not found or unauthorized' }, 403);
		}

		const body = c.req.valid('json');
		const persisted = await persistVenuePackage(vid, body);
		if (!persisted.ok)
			return c.json({ error: persisted.error }, persisted.statusCode);
		return c.json({ data: persisted.data }, 201);
	},
);

venuePackagesRouter.get('/:id/event-packages', async (c) => {
	const vid = c.req.param('id');
	if (!z.string().uuid().safeParse(vid).success) {
		return c.json({ error: 'Байршлын ID буруу байна' }, 400);
	}
	const { data: venue } = await supabase
		.from('venues')
		.select('id')
		.eq('id', vid)
		.eq('status', 'enabled')
		.maybeSingle();
	if (!venue) return c.json({ error: 'Venue not found' }, 404);

	const { data, error } = await supabase
		.from('venue_event_packages')
		.select(`${PACKAGE_SELECT_PUBLIC}, venue_package_services (${PACKAGE_SERVICE_SELECT})`)
		.eq('venue_id', vid)
		.eq('is_active', true)
		.order('sort_order', { ascending: true })
		.order('created_at', { ascending: false });

	if (error) return c.json({ error: error.message }, 500);
	return c.json({ data: data ?? [] });
});

venuePackagesRouter.patch(
	'/event-packages/:packageId',
	authenticate,
	requireProvider,
	zValidator('json', patchPackageBodySchema),
	async (c) => {
		const pkgId = c.req.param('packageId');
		if (!z.string().uuid().safeParse(pkgId).success) {
			return c.json({ error: 'Багцын ID буруу байна' }, 400);
		}
		const user = c.var.user;

		const { data: existing } = await supabase
			.from('venue_event_packages')
			.select('venue_id')
			.eq('id', pkgId)
			.maybeSingle();

		if (!existing) return c.json({ error: 'Package not found' }, 404);

		try {
			await assertVenueWriteAccess(user, existing.venue_id);
		} catch {
			return c.json({ error: 'Venue not found or unauthorized' }, 403);
		}

		const body = c.req.valid('json');

		let didPackageUpdate = false;
		const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

		if (body.slug !== undefined) {
			didPackageUpdate = true;
			updates.slug = body.slug.trim();
		}
		if (body.name !== undefined) {
			didPackageUpdate = true;
			updates.name = body.name.trim();
		}
		if (body.short_description !== undefined) {
			didPackageUpdate = true;
			updates.short_description = body.short_description;
		}
		if (body.price_per_person !== undefined) {
			didPackageUpdate = true;
			updates.price_per_person = body.price_per_person;
		}
		if (body.guests_min !== undefined) {
			didPackageUpdate = true;
			updates.guests_min = body.guests_min;
		}
		if (body.guests_max !== undefined) {
			didPackageUpdate = true;
			updates.guests_max = body.guests_max;
		}
		if (body.is_active !== undefined) {
			didPackageUpdate = true;
			updates.is_active = body.is_active;
		}
		if (body.sort_order !== undefined) {
			didPackageUpdate = true;
			updates.sort_order = body.sort_order;
		}
		if (body.image_url !== undefined) {
			didPackageUpdate = true;
			updates.image_url = body.image_url ?? null;
		}
		if (body.images !== undefined) {
			didPackageUpdate = true;
			updates.images = body.images;
		}

		if (didPackageUpdate) {
			const { error: upErr } = await supabase.from('venue_event_packages').update(updates).eq('id', pkgId);
			if (upErr) {
				if (upErr.code === '23505') return c.json({ error: 'Slug already exists for this venue' }, 409);
				return c.json({ error: upErr.message }, 400);
			}
		}

		if (body.services !== undefined) {
			const { error: delErr } = await supabase.from('venue_package_services').delete().eq('package_id', pkgId);
			if (delErr) return c.json({ error: delErr.message }, 400);
			if (body.services.length > 0) {
				const resolved = await resolvePackageServiceLines(existing.venue_id, pkgId, body.services);
				if (!resolved.ok) return c.json({ error: resolved.error }, resolved.statusCode);
				const { error: lineErr } = await supabase.from('venue_package_services').insert(resolved.lines);
				if (lineErr) return c.json({ error: lineErr.message }, 400);
			}
		}

		const { data: full } = await supabase
			.from('venue_event_packages')
			.select(`${PACKAGE_SELECT_DETAIL}, venue_package_services (${PACKAGE_SERVICE_SELECT})`)
			.eq('id', pkgId)
			.maybeSingle();

		return c.json({ data: full }, 200);
	},
);

venuePackagesRouter.delete(
	'/event-packages/:packageId',
	authenticate,
	requireProvider,
	async (c) => {
		const pkgId = c.req.param('packageId');
		if (!z.string().uuid().safeParse(pkgId).success) {
			return c.json({ error: 'Багцын ID буруу байна' }, 400);
		}
		const user = c.var.user;

		const { data: existing } = await supabase
			.from('venue_event_packages')
			.select('venue_id')
			.eq('id', pkgId)
			.maybeSingle();

		if (!existing) return c.json({ error: 'Package not found' }, 404);

		try {
			await assertVenueWriteAccess(user, existing.venue_id);
		} catch {
			return c.json({ error: 'Venue not found or unauthorized' }, 403);
		}

		const { error } = await supabase.from('venue_event_packages').delete().eq('id', pkgId);
		if (error) return c.json({ error: error.message }, 500);
		return c.json({ data: { deleted: true, id: pkgId } });
	},
);

export function buildPackageSnapshot(pkg: Record<string, unknown>, guestCount?: number): Record<string, unknown> {
	const raw = pkg.venue_package_services as PackageSvc[] | undefined;
	const services = Array.isArray(raw)
		? [...raw].sort((a, b) => Number(a.sort_order) - Number(b.sort_order))
		: [];
	const pricePerPerson = Number(pkg.price_per_person) || 0;
	const guests = guestCount != null ? Math.max(1, Math.floor(guestCount)) : null;
	return {
		package_name: pkg.name,
		package_slug: pkg.slug,
		price_per_person: pricePerPerson,
		image_url: (pkg.image_url as string) ?? null,
		...(guests != null ? { guest_count: guests, line_total: pricePerPerson * guests } : {}),
		services_included: services
			.filter((s) => s.is_included !== false)
			.map((s) => {
				const linked = s.provider_services as Record<string, unknown> | null | undefined;
				return {
					kind: s.kind,
					title: s.title,
					quantity: s.quantity ?? 1,
					provider_service_id: s.provider_service_id ?? null,
					provider_service_slug: linked?.slug ?? null,
				};
			}),
	};
}
