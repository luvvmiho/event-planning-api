import { supabase } from './supabase.js';

export type EventPlanRow = {
	id: string;
	user_id: string;
	name: string;
	budget: number;
	event_date: string | null;
	guest_count: number | null;
	notes: string | null;
	status: string;
	venue_id: string | null;
	venue_package_id: string | null;
	venue_booking_date: string | null;
	venue_guest_count: number | null;
	created_at: string;
	updated_at: string;
};

export type PlanVenueEstimate = {
	venue_id: string;
	venue_name: string;
	venue_slug: string;
	provider_id: string;
	package_id: string | null;
	package_name: string | null;
	package_slug: string | null;
	guest_count: number;
	booking_date: string | null;
	estimated_price: number;
	pricing_mode: 'per_person' | 'package_flat';
	price_per_person: number | null;
};

export type PlanServiceLine = {
	id: string;
	provider_service_id: string;
	quantity: number;
	sort_order: number;
	estimated_price: number;
	service: {
		id: string;
		slug: string;
		name: string;
		kind: string;
		price_flat: number;
		provider_id: string;
		image_url: string | null;
	};
};

export type EventPlanSummary = {
	budget: number;
	estimated_total: number;
	remaining_budget: number;
	over_budget: boolean;
	venue: PlanVenueEstimate | null;
	services: PlanServiceLine[];
	mixed_providers: boolean;
	provider_ids: string[];
};

export async function loadEventPlanForUser(
	planId: string,
	userId: string,
): Promise<{ plan: EventPlanRow | null; forbidden: boolean }> {
	const { data, error } = await supabase.from('event_plans').select('*').eq('id', planId).maybeSingle();
	if (error || !data) return { plan: null, forbidden: false };
	if (data.user_id !== userId) return { plan: null, forbidden: true };
	return { plan: data as EventPlanRow, forbidden: false };
}

export async function buildEventPlanSummary(plan: EventPlanRow): Promise<EventPlanSummary> {
	let venuePart: PlanVenueEstimate | null = null;
	const providerIds = new Set<string>();

	if (plan.venue_id) {
		const guests = plan.venue_guest_count ?? plan.guest_count ?? 1;
		const { data: venue } = await supabase
			.from('venues')
			.select('id, slug, name, provider_id, price_per_person, status')
			.eq('id', plan.venue_id)
			.eq('status', 'published')
			.maybeSingle();

		if (venue) {
			providerIds.add(venue.provider_id as string);
			let estimated = guests * Number(venue.price_per_person);
			let pricing_mode: 'per_person' | 'package_flat' = 'per_person';
			let packageId: string | null = null;
			let packageName: string | null = null;
			let packageSlug: string | null = null;

			if (plan.venue_package_id) {
				const { data: pkg } = await supabase
					.from('venue_event_packages')
					.select('id, slug, name, price_flat, is_active')
					.eq('id', plan.venue_package_id)
					.eq('venue_id', plan.venue_id)
					.eq('is_active', true)
					.maybeSingle();
				if (pkg) {
					estimated = pkg.price_flat;
					pricing_mode = 'package_flat';
					packageId = pkg.id;
					packageName = pkg.name;
					packageSlug = pkg.slug;
				}
			}

			venuePart = {
				venue_id: venue.id,
				venue_name: venue.name,
				venue_slug: venue.slug,
				provider_id: venue.provider_id as string,
				package_id: packageId,
				package_name: packageName,
				package_slug: packageSlug,
				guest_count: guests,
				booking_date: plan.venue_booking_date,
				estimated_price: estimated,
				pricing_mode,
				price_per_person: venue.price_per_person,
			};
		}
	}

	const { data: lines } = await supabase
		.from('event_plan_services')
		.select(
			'id, provider_service_id, quantity, sort_order, provider_services (id, slug, name, kind, price_flat, provider_id, image_url, status)',
		)
		.eq('plan_id', plan.id)
		.order('sort_order', { ascending: true });

	const services: PlanServiceLine[] = [];
	for (const row of lines ?? []) {
		const raw = row.provider_services as Record<string, unknown> | Record<string, unknown>[] | null;
		const svc = Array.isArray(raw) ? raw[0] : raw;
		if (!svc || svc.status !== 'published') continue;
		providerIds.add(String(svc.provider_id));
		const qty = Number(row.quantity) || 1;
		services.push({
			id: row.id,
			provider_service_id: row.provider_service_id,
			quantity: qty,
			sort_order: row.sort_order,
			estimated_price: Number(svc.price_flat) * qty,
			service: {
				id: String(svc.id),
				slug: String(svc.slug),
				name: String(svc.name),
				kind: String(svc.kind),
				price_flat: Number(svc.price_flat),
				provider_id: String(svc.provider_id),
				image_url: (svc.image_url as string) ?? null,
			},
		});
	}

	const venueTotal = venuePart?.estimated_price ?? 0;
	const servicesTotal = services.reduce((s, l) => s + l.estimated_price, 0);
	const estimated_total = venueTotal + servicesTotal;
	const budget = plan.budget;
	const remaining_budget = budget - estimated_total;

	return {
		budget,
		estimated_total,
		remaining_budget,
		over_budget: estimated_total > budget,
		venue: venuePart,
		services,
		mixed_providers: providerIds.size > 1,
		provider_ids: [...providerIds],
	};
}
