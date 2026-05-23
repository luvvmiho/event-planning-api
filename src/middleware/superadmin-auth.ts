import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';
import { verifySuperadminAccessToken } from '../lib/superadmin-token.js';

export const requireSuperadminToken = createMiddleware(async (c, next) => {
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		throw new HTTPException(401, { message: 'Missing superadmin Bearer token' });
	}

	const token = authHeader.slice(7).trim();
	if (!token) {
		throw new HTTPException(401, { message: 'Missing superadmin Bearer token' });
	}

	try {
		const { username, monitoringAdminId } = await verifySuperadminAccessToken(token);
		c.set('superadmin', { username, monitoringAdminId });
		await next();
	} catch {
		throw new HTTPException(401, { message: 'Invalid or expired superadmin token' });
	}
});
