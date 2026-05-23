/**
 * Seed provider_services for a provider.
 * Usage: node scripts/seed-provider-services.mjs [providerId]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const PROVIDER_ID = process.argv[2] ?? 'bd8ab946-61f3-46ce-9dde-84db6c71f1b3';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
	console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
	process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
	auth: { persistSession: false },
});

const SERVICES = [
	{
		slug: 'wedding-limo-package',
		name: 'Гэрлэлтийн лимузин',
		kind: 'car',
		short_description: 'Mercedes S-Class — 8 цаг, жолоочтой.',
		description: 'Гэрлэлтийн өдөр лимузин түрээс. Улаанбаатар дотор, 8 цаг хүртэл.',
		price_flat: 850_000,
		location: 'Улаанбаатар',
		status: 'published',
		sort_order: 0,
	},
	{
		slug: 'birthday-cake-deluxe',
		name: 'Төрсөн өдрийн торт (3 давхар)',
		kind: 'cake',
		short_description: 'Захиалгат загвар, 30–50 хүн.',
		description: '3 давхар кремтэй торт, бичээстэй, хүргэлт орсон.',
		price_flat: 280_000,
		location: 'Улаанбаатар',
		status: 'published',
		sort_order: 1,
	},
	{
		slug: 'wedding-photo-full-day',
		name: 'Гэрлэлтийн зураг авалт — бүтэн өдөр',
		kind: 'photoshoot',
		short_description: '2 фотограф, 400+ зураг, засварласан альбом.',
		description: 'Бэлтгэл, гэрлэлт, зочид буудал хүртэл. 2 фотограф, drone optional add-on.',
		price_flat: 1_200_000,
		location: 'Улаанбаатар',
		status: 'published',
		sort_order: 2,
	},
	{
		slug: 'event-dj-sound',
		name: 'DJ + дууны систем',
		kind: 'entertainment',
		short_description: '4 цаг DJ, чанарын чанга яригч, гэрэл.',
		description: 'Арга хэмжээнд DJ үйлчилгээ, дууны систем, суурь гэрэлтүүлэг.',
		price_flat: 450_000,
		location: 'Улаанбаатар',
		status: 'published',
		sort_order: 3,
	},
	{
		slug: 'venue-floral-decoration',
		name: 'Цэцэглэлт — арга хэмжээний танхим',
		kind: 'decoration',
		short_description: 'Ширээ, үүд, фото булан чимэглэл.',
		description: 'Свеж цэцэг, ширээний төв, үүдний чимэглэл, фото булан.',
		price_flat: 620_000,
		location: 'Улаанбаатар',
		status: 'published',
		sort_order: 4,
	},
	{
		slug: 'corporate-catering-50',
		name: 'Байгууллагын кейтеринг (50 хүн)',
		kind: 'catering',
		short_description: 'Буфет хоол, ажилтан 2, хэрэгсэл.',
		description: '50 хүртэлх хүнд зориулсан буфет, зөөгч 2, хэрэгслийн түрээс.',
		price_flat: 980_000,
		location: 'Улаанбаатар',
		status: 'draft',
		sort_order: 5,
	},
];

async function main() {
	const { data: user, error: userErr } = await supabase.auth.admin.getUserById(PROVIDER_ID);
	if (userErr || !user?.user) {
		console.warn('Auth user lookup:', userErr?.message ?? 'not found (continuing if FK allows)');
	}

	const { data: existing } = await supabase
		.from('provider_services')
		.select('slug')
		.eq('provider_id', PROVIDER_ID);

	const existingSlugs = new Set((existing ?? []).map((r) => r.slug));
	console.log(`Seeding services for provider ${PROVIDER_ID}`);

	for (const svc of SERVICES) {
		if (existingSlugs.has(svc.slug)) {
			console.log(`  skip (exists): ${svc.slug}`);
			continue;
		}

		const row = {
			provider_id: PROVIDER_ID,
			...svc,
			image_url: null,
			images: [],
			updated_at: new Date().toISOString(),
		};

		const { data, error } = await supabase
			.from('provider_services')
			.insert(row)
			.select('id, slug, name, kind, price_flat, status')
			.single();

		if (error) {
			console.error(`  failed ${svc.slug}:`, error.message);
			continue;
		}

		console.log(`  created: ${data.slug} — ${data.name} (${data.price_flat}₮, ${data.status})`);
	}

	const { data: all } = await supabase
		.from('provider_services')
		.select('id, slug, name, kind, price_flat, status')
		.eq('provider_id', PROVIDER_ID)
		.order('sort_order');

	console.log('\nAll services for provider:', JSON.stringify(all, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
