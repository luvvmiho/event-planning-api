import { serve } from '@hono/node-server';
import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { logger } from 'hono/logger';

import { adminOrdersRouter } from './routes/admin/orders.js';
import { adminProvidersRouter } from './routes/admin/providers.js';
import { categoriesRouter } from './routes/categories.js';
import { monitoringRouter } from './routes/monitoring.js';
import { ordersRouter } from './routes/orders.js';
import { providerRouter } from './routes/provider.js';
import { timeSlotsRouter } from './routes/time-slots.js';
import { uploadsRouter } from './routes/uploads.js';
import { servicesRouter } from './routes/services.js';
import { venuesRouter } from './routes/venues.js';
import { eventPlansRouter } from './routes/event-plans.js';
import { wishlistRouter } from './routes/wishlist.js';

const app = new Hono();

app.use(logger());

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000')
	.split(',')
	.map((o) => o.trim());

app.use(
	cors({
		origin: (origin) => (allowedOrigins.includes(origin) ? origin : allowedOrigins[0]),
		allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
		allowHeaders: ['Content-Type', 'Authorization'],
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
		return c.json({ error: err.message }, err.status);
	}

	console.error('[unhandled error]', err);
	return c.json({ error: 'Internal server error' }, 500);
});

app.notFound((c) => c.json({ error: 'Route not found' }, 404));

const port = parseInt(process.env.PORT ?? '4000', 10);

serve({ fetch: app.fetch, port }, () => {
	console.log(`🚀 Nairly API running on http://localhost:${port}`);
});
