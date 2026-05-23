import { timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { supabase } from './supabase.js';

export function normalizeMonitoringUsername(username: string): string {
	return username.trim().toLowerCase().slice(0, 128);
}

export function hashMonitoringPassword(plainPassword: string): string {
	return bcrypt.hashSync(plainPassword, 12);
}

function timingSafeUsername(input: string, expected: string): boolean {
	try {
		const a = Buffer.from(input, 'utf8');
		const b = Buffer.from(expected, 'utf8');
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	} catch {
		return false;
	}
}

async function verifyEnvMonitoringCredentials(normalizedUsername: string, password: string): Promise<boolean> {
	const envUser = process.env.SUPERADMIN_USERNAME?.trim();
	const bcryptHash = process.env.SUPERADMIN_PASSWORD_BCRYPT?.trim();
	if (!envUser || !bcryptHash) return false;
	const envNorm = normalizeMonitoringUsername(envUser);
	if (!timingSafeUsername(normalizedUsername, envNorm)) return false;
	if (!password || password.length > 4096) return false;
	return bcrypt.compare(password, bcryptHash);
}

export type MonitoringLoginResult =
	| { source: 'db'; monitoringAdminId: string; username: string }
	| { source: 'env'; username: string };

/**
 * DB `monitoring_admins` rows first (password disabled accounts skipped), then env bootstrap match.
 */
export async function authenticateSuperadminLogin(
	usernameRaw: string,
	password: string,
): Promise<MonitoringLoginResult | null> {
	const normalized = normalizeMonitoringUsername(usernameRaw);
	if (!normalized || !password || password.length > 4096) return null;

	const { data: row, error } = await supabase
		.from('monitoring_admins')
		.select('id, username, password_hash, is_disabled')
		.eq('username', normalized)
		.maybeSingle();

	if (!error && row && !row.is_disabled && (await bcrypt.compare(password, row.password_hash))) {
		return { source: 'db', monitoringAdminId: row.id, username: row.username };
	}

	if (await verifyEnvMonitoringCredentials(normalized, password)) {
		return { source: 'env', username: normalized };
	}

	return null;
}
