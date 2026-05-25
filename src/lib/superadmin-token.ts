import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'nairly-superadmin';

function getSecret(): Uint8Array {
	const raw = process.env.SUPERADMIN_JWT_SECRET;
	if (!raw || raw.length < 32) {
		throw new Error('SUPERADMIN_JWT_SECRET must be set and at least 32 characters');
	}
	return new TextEncoder().encode(raw);
}

export async function signSuperadminAccessToken(args: {
	username: string;
	monitoringAdminId?: string;
}): Promise<string> {
	const key = getSecret();
	const payload: Record<string, unknown> = {
		typ: 'superadmin',
		user: args.username,
		src: args.monitoringAdminId ? 'db' : 'env',
	};
	if (args.monitoringAdminId) payload.aid = args.monitoringAdminId;

	return new SignJWT(payload)
		.setProtectedHeader({ alg: 'HS256' })
		.setSubject(args.monitoringAdminId ?? args.username)
		.setIssuer(ISSUER)
		.setIssuedAt()
		.sign(key);
}

export async function verifySuperadminAccessToken(
	token: string,
): Promise<{ username: string; monitoringAdminId?: string }> {
	const key = getSecret();
	const { payload } = await jwtVerify(token, key, { issuer: ISSUER });

	if (payload.typ !== 'superadmin') throw new Error('Invalid token');

	const username = typeof payload.user === 'string' ? payload.user : undefined;
	if (!username) throw new Error('Invalid token');

	const aid =
		typeof payload.aid === 'string' && /^[0-9a-f-]{36}$/i.test(payload.aid)
			? payload.aid
			: undefined;

	return { username, monitoringAdminId: aid };
}
