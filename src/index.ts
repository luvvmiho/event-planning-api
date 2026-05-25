import { serve } from '@hono/node-server';
import 'dotenv/config';
import type { Context } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import { adminOrdersRouter } from './routes/admin/orders.js';
import { adminProvidersRouter } from './routes/admin/providers.js';
import { categoriesRouter } from './routes/categories.js';
import { eventPlansRouter } from './routes/event-plans.js';
import { monitoringRouter } from './routes/monitoring.js';
import { ordersRouter } from './routes/orders.js';
import { providerRouter } from './routes/provider.js';
import { servicesRouter } from './routes/services.js';
import { timeSlotsRouter } from './routes/time-slots.js';
import { uploadsRouter } from './routes/uploads.js';
import { venuesRouter } from './routes/venues.js';
import { wishlistRouter } from './routes/wishlist.js';

const app = new Hono();

app.use(logger());

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
	.split(',')
	.map((o) => o.trim().replace(/\/$/, ''))
	.filter(Boolean);

const allowVercelPreviews = allowedOrigins.some((o) => o.endsWith('.vercel.app'));

const isOriginAllowed = (origin: string): boolean => {
	const normalized = origin.replace(/\/$/, '');
	if (allowedOrigins.includes(normalized)) return true;
	if (allowVercelPreviews && /\.vercel\.app$/.test(normalized)) return true;
	return false;
};

const resolveAllowOrigin = (origin: string | undefined): string | null => {
	if (!origin) return allowedOrigins[0] ?? null;
	const normalized = origin.replace(/\/$/, '');
	return isOriginAllowed(normalized) ? normalized : null;
};

const applyCorsToResponse = (c: Context, res: Response): Response => {
	const allowOrigin = resolveAllowOrigin(c.req.header('origin'));
	if (allowOrigin) {
		res.headers.set('Access-Control-Allow-Origin', allowOrigin);
		res.headers.set('Access-Control-Allow-Credentials', 'true');
		res.headers.append('Vary', 'Origin');
	}
	return res;
};

app.use(
	cors({
		origin: (origin) => {
			const resolved = resolveAllowOrigin(origin || undefined);
			if (origin && !resolved) {
				console.warn(
					'[cors] rejected origin:',
					origin,
					'| allowed:',
					allowedOrigins.join(', '),
				);
			}
			return resolved;
		},
		allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
		credentials: true,
	}),
);

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/venues', venuesRouter);
app.route('/services', servicesRouter);
app.route('/uploads', uploadsRouter);
app.route('/time-slots', timeSlotsRouter);
app.route('/categories', categoriesRouter);
app.route('/orders', ordersRouter);
app.route('/event-plans', eventPlansRouter);
app.route('/wishlist', wishlistRouter);
app.route('/provider', providerRouter);
app.route('/admin/orders', adminOrdersRouter);
app.route('/admin/providers', adminProvidersRouter);
app.route('/monitoring', monitoringRouter);

app.onError((err, c) => {
	if (err instanceof HTTPException) {
		return applyCorsToResponse(c, c.json({ error: err.message }, err.status));
	}

	console.error('[unhandled error]', err);
	return applyCorsToResponse(c, c.json({ error: 'Internal server error' }, 500));
});

app.notFound((c) => applyCorsToResponse(c, c.json({ error: 'Route not found' }, 404)));

const port = parseInt(process.env.PORT ?? '4000', 10);

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, (info) => {
	console.log(`🚀 Nairly API running on http://localhost:${port}`);
});
