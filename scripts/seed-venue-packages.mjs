/**
 * One-off seed: event packages for a venue.
 * Usage: node scripts/seed-venue-packages.mjs [venueId]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const VENUE_ID = process.argv[2] ?? '4bd1c6a9-bc28-4fe0-9531-a182e099042b';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !supabaseServiceKey) {
	console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
	process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
	auth: { persistSession: false },
});

const PACKAGES = [
	{
		slug: 'birthday-standard',
		name: 'Төрсөн өдрийн стандарт багц',
		short_description: '40–80 зочинд тохирсон төрсөн өдрийн багц — хоол, амттан, чимэглэл.',
		price_flat: 1_850_000,
		guests_min: 40,
		guests_max: 80,
		sort_order: 0,
		services: [
			{ kind: 'food', title: 'Буфет хоол', description: 'Үндсэн 6 төрлийн хоол', quantity: 1, is_included: true, sort_order: 0 },
			{ kind: 'cake', title: '2 давхар торт', quantity: 1, is_included: true, sort_order: 1 },
			{ kind: 'decoration', title: 'Төрсөн өдрийн чимэглэл', quantity: 1, is_included: true, sort_order: 2 },
			{ kind: 'staff', title: 'Зөөгч 2 хүн', quantity: 2, is_included: true, sort_order: 3 },
		],
	},
	{
		slug: 'wedding-premium',
		name: 'Гэрлэлтийн премиум багц',
		short_description: '100–200 зочин — бүрэн хоол, торт, хөгжим, чимэглэл.',
		price_flat: 6_500_000,
		guests_min: 100,
		guests_max: 200,
		sort_order: 1,
		services: [
			{ kind: 'food', title: 'Банкет хоол', description: '8 төрлийн үндсэн хоол + салат', quantity: 1, is_included: true, sort_order: 0 },
			{ kind: 'cake', title: '3 давхар гэрлэлтийн торт', quantity: 1, is_included: true, sort_order: 1 },
			{ kind: 'entertainment', title: 'DJ + дууны систем', quantity: 1, is_included: true, sort_order: 2 },
			{ kind: 'decoration', title: 'Ширээний чимэглэл + цэцэг', quantity: 1, is_included: true, sort_order: 3 },
			{ kind: 'staff', title: 'Зөөгч баг', quantity: 6, is_included: true, sort_order: 4 },
		],
	},
	{
		slug: 'corporate-lunch',
		name: 'Байгууллагын өдөрлөг',
		short_description: '20–50 зочин — өдрийн хоол, кофе цай, төсөвт тохирсон.',
		price_flat: 980_000,
		guests_min: 20,
		guests_max: 50,
		sort_order: 2,
		services: [
			{ kind: 'food', title: 'Өдрийн хоол (set menu)', quantity: 1, is_included: true, sort_order: 0 },
			{ kind: 'other', title: 'Кофе, цай, ус', quantity: 1, is_included: true, sort_order: 1 },
			{ kind: 'staff', title: 'Зөөгч 1 хүн', quantity: 1, is_included: true, sort_order: 2 },
		],
	},
];

async function main() {
	const { data: venue, error: venueErr } = await supabase
		.from('venues')
		.select('id, name, slug')
		.eq('id', VENUE_ID)
		.maybeSingle();

	if (venueErr || !venue) {
		console.error('Venue not found:', VENUE_ID, venueErr?.message);
		process.exit(1);
	}

	console.log(`Seeding packages for: ${venue.name} (${venue.slug})`);

	const { data: existing } = await supabase
		.from('venue_event_packages')
		.select('slug')
		.eq('venue_id', VENUE_ID);

	const existingSlugs = new Set((existing ?? []).map((p) => p.slug));

	for (const pkg of PACKAGES) {
		if (existingSlugs.has(pkg.slug)) {
			console.log(`  skip (exists): ${pkg.slug}`);
			continue;
		}

		const { services, ...pkgRow } = pkg;
		const { data: inserted, error: insErr } = await supabase
			.from('venue_event_packages')
			.insert({
				venue_id: VENUE_ID,
				...pkgRow,
				is_active: true,
				updated_at: new Date().toISOString(),
			})
			.select('id, slug, name, price_flat')
			.single();

		if (insErr) {
			console.error(`  failed ${pkg.slug}:`, insErr.message);
			continue;
		}

		if (services.length > 0) {
			const lines = services.map((s) => ({
				package_id: inserted.id,
				kind: s.kind,
				title: s.title,
				description: s.description ?? null,
				quantity: s.quantity,
				is_included: s.is_included,
				sort_order: s.sort_order,
			}));
			const { error: svcErr } = await supabase.from('venue_package_services').insert(lines);
			if (svcErr) {
				console.error(`  services failed for ${pkg.slug}:`, svcErr.message);
				await supabase.from('venue_event_packages').delete().eq('id', inserted.id);
				continue;
			}
		}

		console.log(`  created: ${inserted.slug} — ${inserted.name} (${inserted.price_flat}₮)`);
	}

	const { data: all } = await supabase
		.from('venue_event_packages')
		.select('id, slug, name, price_flat, guests_min, guests_max, venue_package_services (kind, title)')
		.eq('venue_id', VENUE_ID)
		.order('sort_order');

	console.log('\nAll packages on venue:', JSON.stringify(all, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
