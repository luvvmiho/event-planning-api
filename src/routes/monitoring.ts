import { zValidator } from '@hono/zod-validator';
import type { User } from '@supabase/supabase-js';
import { Hono } from 'hono';
import { z } from 'zod';
import { supabase } from '../lib/supabase.js';
import {
	authenticateSuperadminLogin,
	hashMonitoringPassword,
	normalizeMonitoringUsername,
} from '../lib/superadmin-login.js';
import { signSuperadminAccessToken } from '../lib/superadmin-token.js';
import { syncVenueBookingsForOrder } from '../lib/venue-bookings.js';
import { mapSupabaseUserToAuthUser } from '../middleware/auth.js';
import { requireSuperadminToken } from '../middleware/superadmin-auth.js';

export const monitoringRouter = new Hono();

monitoringRouter.post(
	'/login',
	zValidator(
		'json',
		z.object({
			username: z.string().min(1),
			password: z.string().min(1).max(4096),
		}),
	),
	async (c) => {
		const { username, password } = c.req.valid('json');
		const session = await authenticateSuperadminLogin(username, password);
		if (!session) {
			return c.json({ error: 'Invalid credentials' }, 401);
		}

		const token = await signSuperadminAccessToken(
			session.source === 'db'
				? { username: session.username, monitoringAdminId: session.monitoringAdminId }
				: { username: session.username },
		);
		return c.json({
			data: {
				access_token: token,
				token_type: 'Bearer',
				auth_source: session.source,
				monitoring_admin_id: session.source === 'db' ? session.monitoringAdminId : null,
			},
		});
	},
);

/** All routes below require Authorization: Bearer <superadmin JWT> */
const guarded = new Hono();
guarded.use('*', requireSuperadminToken);

const monitoringAdminUsernameSchema = z
	.string()
	.min(2)
	.max(128)
	.regex(/^[a-z0-9._-]+$/i, 'Letters, numbers, . _ - only');

guarded.get('/admins', async (c) => {
	const { data, error } = await supabase
		.from('monitoring_admins')
		.select('id, username, display_name, is_disabled, created_at, updated_at')
		.order('created_at', { ascending: false });

	if (error) return c.json({ error: error.message }, 500);
	return c.json({ data: data ?? [] });
});

guarded.get('/admins/:id', async (c) => {
	const id = c.req.param('id');
	if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid id' }, 400);

	const { data, error } = await supabase
		.from('monitoring_admins')
		.select('id, username, display_name, is_disabled, created_at, updated_at')
		.eq('id', id)
		.maybeSingle();

	if (error) return c.json({ error: error.message }, 500);
	if (!data) return c.json({ error: 'Not found' }, 404);

	return c.json({ data });
});

guarded.post(
	'/admins',
	zValidator(
		'json',
		z.object({
			username: monitoringAdminUsernameSchema,
			password: z.string().min(8).max(4096),
			display_name: z.string().trim().max(200).optional(),
		}),
	),
	async (c) => {
		const body = c.req.valid('json');
		const username = normalizeMonitoringUsername(body.username);
		if (!username) return c.json({ error: 'Invalid username' }, 400);

		const hash = hashMonitoringPassword(body.password);
		const { data, error } = await supabase
			.from('monitoring_admins')
			.insert({
				username,
				password_hash: hash,
				display_name: body.display_name?.trim() ?? null,
			})
			.select('id, username, display_name, is_disabled, created_at, updated_at')
			.single();

		if (error) {
			if (error.code === '23505') return c.json({ error: 'Username already exists' }, 409);
			return c.json({ error: error.message }, 400);
		}

		return c.json({ data }, 201);
	},
);

const patchMonitoringAdminSchema = z
	.object({
		username: monitoringAdminUsernameSchema.optional(),
		password: z.string().min(8).max(4096).optional(),
		display_name: z.string().trim().max(200).nullable().optional(),
		is_disabled: z.boolean().optional(),
	})
	.refine(
		(v) =>
			v.username !== undefined ||
			v.password !== undefined ||
			v.display_name !== undefined ||
			v.is_disabled !== undefined,
		{ message: 'At least one field required' },
	);

guarded.patch('/admins/:id', zValidator('json', patchMonitoringAdminSchema), async (c) => {
	const id = c.req.param('id');
	if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid id' }, 400);

	const body = c.req.valid('json');
	const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

	if (body.username !== undefined) {
		const nu = normalizeMonitoringUsername(body.username);
		if (!nu) return c.json({ error: 'Invalid username' }, 400);
		updates.username = nu;
	}
	if (body.password !== undefined) updates.password_hash = hashMonitoringPassword(body.password);
	if (body.display_name !== undefined) updates.display_name = body.display_name;
	if (body.is_disabled !== undefined) updates.is_disabled = body.is_disabled;
	const { data, error } = await supabase
		.from('monitoring_admins')
		.update(updates)
		.eq('id', id)
		.select('id, username, display_name, is_disabled, created_at, updated_at')
		.maybeSingle();

	if (error) {
		if (error.code === '23505') return c.json({ error: 'Username already exists' }, 409);
		return c.json({ error: error.message }, 400);
	}
	if (!data) return c.json({ error: 'Not found' }, 404);

	return c.json({ data });
});

guarded.delete('/admins/:id', async (c) => {
	const id = c.req.param('id');
	if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid id' }, 400);

	if (c.var.superadmin.monitoringAdminId === id) {
		return c.json({ error: 'Cannot delete the account currently signed in' }, 400);
	}

	const { data, error } = await supabase
		.from('monitoring_admins')
		.delete()
		.eq('id', id)
		.select('id')
		.maybeSingle();

	if (error) return c.json({ error: error.message }, 500);
	if (!data) return c.json({ error: 'Not found' }, 404);

	return c.json({ data: { deleted: true, id } });
});

guarded.get('/overview', async (c) => {
	try {
		const [
			{ count: profileCount },
			{ count: venueCount },
			{ count: orderCount },
			pending,
			paidCnt,
			cancelled,
		] = await Promise.all([
			supabase.from('profiles').select('id', { count: 'exact', head: true }),
			supabase.from('venues').select('id', { count: 'exact', head: true }),
			supabase.from('orders').select('id', { count: 'exact', head: true }),
			supabase
				.from('orders')
				.select('id', { count: 'exact', head: true })
				.eq('status', 'pending'),
			supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid'),
			supabase
				.from('orders')
				.select('id', { count: 'exact', head: true })
				.eq('status', 'cancelled'),
		]);

		let authUserTotal = 0;
		let providerRoles = 0;
		let pageNum = 1;
		const perPage = 200;
		for (;;) {
			const { data, error } = await supabase.auth.admin.listUsers({ page: pageNum, perPage });
			if (error) break;
			const batch = data?.users ?? [];
			authUserTotal += batch.length;
			for (const u of batch) {
				if (mapSupabaseUserToAuthUser(u).role === 'provider') providerRoles += 1;
			}
			if (batch.length < perPage) break;
			pageNum += 1;
			if (pageNum > 400) break;
		}

		return c.json({
			data: {
				auth_users_estimate: authUserTotal,
				profiles: profileCount ?? 0,
				providers_by_role_hint: providerRoles,
				venues: venueCount ?? 0,
				orders_total: orderCount ?? 0,
				orders_pending: pending.count ?? 0,
				orders_paid: paidCnt.count ?? 0,
				orders_cancelled: cancelled.count ?? 0,
				superadmin_username: c.var.superadmin.username,
			},
		});
	} catch {
		return c.json({ error: 'Failed to aggregate overview metrics' }, 500);
	}
});

const paginationSchema = z.object({
	page: z.coerce.number().min(1).default(1),
	perPage: z.coerce.number().min(1).max(500).default(50),
});

guarded.get('/users', zValidator('query', paginationSchema), async (c) => {
	const { page, perPage } = c.req.valid('query');
	const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });

	if (error) return c.json({ error: error.message }, 500);

	const users =
		data?.users?.map((u) => ({
			id: u.id,
			email: u.email,
			phone: u.phone,
			created_at: u.created_at,
			last_sign_in_at: u.last_sign_in_at,
			confirmed_at: u.email_confirmed_at,
			app_metadata: u.app_metadata,
			user_metadata: u.user_metadata,
			role: mapSupabaseUserToAuthUser(u).role,
			banned_until: u.banned_until ?? null,
		})) ?? [];

	return c.json({
		data: users,
		meta: {
			page,
			perPage,
			pageSize: users.length,
		},
	});
});

guarded.get('/users/:id', async (c) => {
	const id = c.req.param('id');
	if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid user id' }, 400);

	const {
		data: { user },
		error,
	} = await supabase.auth.admin.getUserById(id);
	if (error || !user) return c.json({ error: 'User not found' }, 404);

	const { data: profile } = await supabase.from('profiles').select('*').eq('id', id).maybeSingle();

	return c.json({
		data: {
			id: user.id,
			email: user.email,
			phone: user.phone,
			created_at: user.created_at,
			last_sign_in_at: user.last_sign_in_at,
			confirmed_at: user.email_confirmed_at,
			app_metadata: user.app_metadata,
			user_metadata: user.user_metadata,
			role: mapSupabaseUserToAuthUser(user).role,
			banned_until: user.banned_until ?? null,
			profile,
		},
	});
});

const patchUserSchema = z.object({
	role: z.enum(['customer', 'provider', 'admin']).optional(),
	provider_verified: z.boolean().optional(),
	banned: z.boolean().optional(),
	email_confirm: z.boolean().optional(),
});

guarded.patch('/users/:id', zValidator('json', patchUserSchema), async (c) => {
	const id = c.req.param('id');
	if (!z.string().uuid().safeParse(id).success) return c.json({ error: 'Invalid user id' }, 400);

	const body = c.req.valid('json');

	const {
		data: { user },
		error: loadErr,
	} = await supabase.auth.admin.getUserById(id);
	if (loadErr || !user) return c.json({ error: 'User not found' }, 404);

	const md: Record<string, unknown> = {
		...(typeof user.app_metadata === 'object' && user.app_metadata !== null
			? user.app_metadata
			: {}),
	};
	if (body.role !== undefined) md.role = body.role;
	if (body.provider_verified !== undefined) md.provider_verified = body.provider_verified;

	const updateAttrs: Parameters<typeof supabase.auth.admin.updateUserById>[1] = {
		app_metadata: md,
	};

	if (body.banned === true) updateAttrs.ban_duration = '877000h';
	if (body.banned === false) updateAttrs.ban_duration = 'none';

	if (body.email_confirm === true) updateAttrs.email_confirm = true;

	const {
		data: { user: updated },
		error,
	} = await supabase.auth.admin.updateUserById(id, updateAttrs);

	if (error || !updated) return c.json({ error: error?.message ?? 'Update failed' }, 400);

	return c.json({
		data: {
			id: updated.id,
			email: updated.email,
			app_metadata: updated.app_metadata,
			banned_until: updated.banned_until ?? null,
			role: mapSupabaseUserToAuthUser(updated).role,
		},
	});
});

guarded.get('/providers', async (c) => {
	const providers: User[] = [];
	let pageNum = 1;
	const perPage = 300;
	for (;;) {
		const { data, error } = await supabase.auth.admin.listUsers({ page: pageNum, perPage });
		if (error) return c.json({ error: error.message }, 500);
		const batch = data?.users ?? [];
		for (const u of batch) {
			if (mapSupabaseUserToAuthUser(u).role === 'provider') providers.push(u);
		}
		if (batch.length < perPage) break;
		pageNum += 1;
		if (pageNum > 400) break;
	}

	const providerIds = providers.map((p) => p.id);
	let venuesForProviders: Array<Record<string, unknown>> = [];

	if (providerIds.length > 0) {
		const chunkSize = 200;
		for (let i = 0; i < providerIds.length; i += chunkSize) {
			const slice = providerIds.slice(i, i + chunkSize);
			const { data: vs } = await supabase
				.from('venues')
				.select('id, provider_id, name, slug, is_featured')
				.in('provider_id', slice);
			if (vs) venuesForProviders = [...venuesForProviders, ...vs];
		}
	}

	const result = providers.map((p) => ({
		id: p.id,
		email: p.email,
		created_at: p.created_at,
		last_sign_in_at: p.last_sign_in_at,
		verified: p.app_metadata?.provider_verified ?? false,
		app_metadata: p.app_metadata,
		venues: venuesForProviders.filter((v) => v.provider_id === p.id),
	}));

	return c.json({ data: result });
});

guarded.get('/providers/:id', async (c) => {
	const providerId = c.req.param('id');
	if (!z.string().uuid().safeParse(providerId).success)
		return c.json({ error: 'Invalid id' }, 400);

	const {
		data: { user },
		error,
	} = await supabase.auth.admin.getUserById(providerId);
	if (error || !user) return c.json({ error: 'Provider not found' }, 404);
	if (mapSupabaseUserToAuthUser(user).role !== 'provider') {
		return c.json({ error: 'Not a provider account' }, 404);
	}

	const { data: venues } = await supabase
		.from('venues')
		.select('id, name, slug, rating, review_count, price_per_person, is_featured, created_at')
		.eq('provider_id', providerId);

	const venueIds = new Set((venues ?? []).map((v) => v.id as string));

	const { data: orderCandidates } = await supabase
		.from('orders')
		.select('id, status, total, items, created_at')
		.order('created_at', { ascending: false })
		.limit(400);

	const recentOrders = (orderCandidates ?? [])
		.filter((o) => {
			const raw = o.items;
			const items = Array.isArray(raw) ? raw : [];
			return items.some((it: unknown) => {
				if (typeof it !== 'object' || it === null || !('venueId' in it)) return false;
				const vid = (it as { venueId: unknown }).venueId;
				return typeof vid === 'string' && venueIds.has(vid);
			});
		})
		.slice(0, 50);

	return c.json({
		data: {
			id: user.id,
			email: user.email,
			created_at: user.created_at,
			verified: user.app_metadata?.provider_verified ?? false,
			app_metadata: user.app_metadata,
			user_metadata: user.user_metadata,
			venues: venues ?? [],
			recent_orders: recentOrders,
		},
	});
});

guarded.patch(
	'/providers/:id/verify',
	zValidator('json', z.object({ verified: z.boolean() })),
	async (c) => {
		const providerId = c.req.param('id');
		const { verified } = c.req.valid('json');

		const {
			data: { user },
			error,
		} = await supabase.auth.admin.updateUserById(providerId, {
			app_metadata: { role: 'provider', provider_verified: verified },
		});

		if (error || !user) return c.json({ error: error?.message ?? 'Update failed' }, 400);

		return c.json({
			data: { id: user.id, email: user.email, verified },
		});
	},
);

guarded.patch(
	'/providers/:id/role',
	zValidator('json', z.object({ role: z.enum(['customer', 'provider', 'admin']) })),
	async (c) => {
		const userId = c.req.param('id');
		const { role } = c.req.valid('json');

		const {
			data: { user },
			error,
		} = await supabase.auth.admin.updateUserById(userId, {
			app_metadata: { role },
		});

		if (error || !user) return c.json({ error: error?.message ?? 'Update failed' }, 400);

		return c.json({ data: { id: user.id, email: user.email, role } });
	},
);

const ordersListSchema = z.object({
	status: z.enum(['pending', 'paid', 'cancelled']).optional(),
	from: z.string().optional(),
	to: z.string().optional(),
	page: z.coerce.number().min(1).default(1),
	limit: z.coerce.number().min(1).max(200).default(20),
});

guarded.get('/orders', zValidator('query', ordersListSchema), async (c) => {
	const { status, from, to, page, limit } = c.req.valid('query');
	const offset = (page - 1) * limit;

	let query = supabase
		.from('orders')
		.select('*', { count: 'exact' })
		.order('created_at', { ascending: false })
		.range(offset, offset + limit - 1);

	if (status) query = query.eq('status', status);
	if (from) query = query.gte('created_at', from);
	if (to) query = query.lte('created_at', to);

	const { data, error, count } = await query;
	if (error) return c.json({ error: error.message }, 500);

	return c.json({
		data: data ?? [],
		meta: {
			total: count ?? 0,
			page,
			limit,
			totalPages: Math.ceil((count ?? 0) / limit),
		},
	});
});

guarded.get('/orders/stats', async (c) => {
	const [pending, paidCount, cancelled, revenue] = await Promise.all([
		supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'pending'),
		supabase.from('orders').select('id', { count: 'exact', head: true }).eq('status', 'paid'),
		supabase
			.from('orders')
			.select('id', { count: 'exact', head: true })
			.eq('status', 'cancelled'),
		supabase.from('orders').select('total').eq('status', 'paid'),
	]);

	const totalRevenue = (revenue.data ?? []).reduce((sum, o) => sum + (Number(o.total) || 0), 0);

	return c.json({
		data: {
			pending: pending.count ?? 0,
			paid: paidCount.count ?? 0,
			cancelled: cancelled.count ?? 0,
			totalRevenue,
		},
	});
});

guarded.patch(
	'/orders/:id',
	zValidator('json', z.object({ status: z.enum(['pending', 'paid', 'cancelled']) })),
	async (c) => {
		const orderId = c.req.param('id');
		const { status } = c.req.valid('json');

		const { data, error } = await supabase
			.from('orders')
			.update({ status })
			.eq('id', orderId)
			.select()
			.single();

		if (error) return c.json({ error: error.message }, 400);
		if (!data) return c.json({ error: 'Order not found' }, 404);

		await syncVenueBookingsForOrder(data.id, data.items, data.status);

		return c.json({ data });
	},
);

monitoringRouter.route('/', guarded);
