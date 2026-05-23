import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { supabase } from '../lib/supabase.js';
import { authenticate, requireProvider } from '../middleware/auth.js';

export const uploadsRouter = new Hono();

const MAX_BYTES = 5 * 1024 * 1024;

const MIME_EXT: Record<string, string> = {
	'image/jpeg': '.jpg',
	'image/png': '.png',
	'image/webp': '.webp',
	'image/gif': '.gif',
};

const extToMime = (ext: string): string => {
	const e = Object.entries(MIME_EXT).find(([, v]) => v === ext);
	return e?.[0] ?? 'image/jpeg';
};

function extForUpload(file: File): string | null {
	const t = file.type;
	if (t && MIME_EXT[t]) return MIME_EXT[t];

	const n = file.name.toLowerCase();
	if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return '.jpg';
	if (n.endsWith('.png')) return '.png';
	if (n.endsWith('.webp')) return '.webp';
	if (n.endsWith('.gif')) return '.gif';
	return null;
}

uploadsRouter.post('/venue-image', authenticate, requireProvider, async (c) => {
	const user = c.var.user;
	const bucket = process.env.SUPABASE_VENUE_IMAGES_BUCKET ?? 'nairly';

	let body: Record<string, unknown>;
	try {
		body = await c.req.parseBody();
	} catch {
		return c.json({ error: 'Зургийн файл хүлээн авахад алдаа гарлаа' }, 400);
	}

	const raw = body.file;
	if (!(raw instanceof File)) {
		return c.json({ error: 'Зургийн файл сонгоно уу' }, 400);
	}

	if (raw.size > MAX_BYTES) {
		return c.json({ error: 'Файл 5MB-аас их байна' }, 413);
	}

	if (raw.type && !(raw.type in MIME_EXT)) {
		return c.json({ error: 'Зөвхөн JPEG, PNG, WebP, GIF зөвшөөрнө' }, 400);
	}

	const ext = extForUpload(raw);
	if (!ext) {
		return c.json({ error: 'Зөвхөн JPEG, PNG, WebP, GIF зөвшөөрнө' }, 400);
	}

	const contentType = raw.type && raw.type in MIME_EXT ? raw.type : extToMime(ext);
	const storagePath = `${user.id}/${randomUUID()}${ext}`;
	const buf = Buffer.from(await raw.arrayBuffer());

	const { error: upErr } = await supabase.storage.from(bucket).upload(storagePath, buf, {
		contentType,
		upsert: false,
	});

	if (upErr) {
		console.error('venue-image upload', upErr);
		return c.json({ error: upErr.message ?? 'Ачаалахад алдаа гарлаа' }, 400);
	}

	const {
		data: { publicUrl },
	} = supabase.storage.from(bucket).getPublicUrl(storagePath);

	return c.json({ url: publicUrl }, 201);
});
