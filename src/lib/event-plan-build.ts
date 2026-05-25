import { supabase } from './supabase.js';
import { venueOnlyOrderPrice, venuePackageOrderPrice } from './venue-pricing.js';
import {
	computeServiceUnitPrice,
	resolveServiceOptionSelections,
	type ResolvedServiceOption,
} from './service-options.js';

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
	pricing_mode: 'venue_flat' | 'package_per_person';
	price_flat: number | null;
	package_price_per_person: number | null;
};

export type PlanServiceLine = {
	id: string;
	provider_service_id: string;
	quantity: number;
	sort_order: number;
	estimated_price: number;
	unit_price: number;
	selected_option_ids: string[];
	selected_options: ResolvedServiceOption[];
	has_option_groups: boolean;
	options_complete: boolean;
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
			.select('id, slug, name, provider_id, price_flat, status')
			.eq('id', plan.venue_id)
			.eq('status', 'enabled')
			.maybeSingle();

		if (venue) {
			providerIds.add(venue.provider_id as string);
			let estimated = venueOnlyOrderPrice(Number(venue.price_flat));
			let pricing_mode: 'venue_flat' | 'package_per_person' = 'venue_flat';
			let packageId: string | null = null;
			let packageName: string | null = null;
			let packageSlug: string | null = null;
			let packagePricePerPerson: number | null = null;

			if (plan.venue_package_id) {
				const { data: pkg } = await supabase
					.from('venue_event_packages')
					.select('id, slug, name, price_per_person, is_active')
					.eq('id', plan.venue_package_id)
					.eq('venue_id', plan.venue_id)
					.eq('is_active', true)
					.maybeSingle();
				if (pkg) {
					packagePricePerPerson = Number(pkg.price_per_person);
					estimated = venuePackageOrderPrice(packagePricePerPerson, guests);
					pricing_mode = 'package_per_person';
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
				price_flat: Number(venue.price_flat),
				package_price_per_person: packagePricePerPerson,
			};
		}
	}

	const { data: lines } = await supabase
		.from('event_plan_services')
		.select(
			'id, provider_service_id, quantity, sort_order, selected_option_ids, provider_services (id, slug, name, kind, price_flat, provider_id, image_url, status)',
		)
		.eq('plan_id', plan.id)
		.order('sort_order', { ascending: true });

	const services: PlanServiceLine[] = [];
	for (const row of lines ?? []) {
		const raw = row.provider_services as Record<string, unknown> | Record<string, unknown>[] | null;
		const svc = Array.isArray(raw) ? raw[0] : raw;
		if (!svc || svc.status !== 'enabled') continue;
		providerIds.add(String(svc.provider_id));
		const qty = Number(row.quantity) || 1;
		const basePrice = Number(svc.price_flat);
		const selectedOptionIds = Array.isArray(row.selected_option_ids)
			? row.selected_option_ids.map(String)
			: [];
		const resolved = await resolveServiceOptionSelections(String(svc.id), selectedOptionIds);
		const hasOptionGroups = resolved.ok && resolved.hasOptionGroups;
		const selections = resolved.ok ? resolved.selections : [];
		const unitPrice = resolved.ok
			? computeServiceUnitPrice(
					basePrice,
					resolved.optionsPriceSum,
					resolved.hasOptionGroups,
					resolved.selections.length > 0,
				)
			: basePrice;
		const optionsComplete = !hasOptionGroups || (selectedOptionIds.length > 0 && resolved.ok);

		services.push({
			id: row.id,
			provider_service_id: row.provider_service_id,
			quantity: qty,
			sort_order: row.sort_order,
			estimated_price: unitPrice * qty,
			unit_price: unitPrice,
			selected_option_ids: selectedOptionIds,
			selected_options: selections,
			has_option_groups: hasOptionGroups,
			options_complete: optionsComplete,
			service: {
				id: String(svc.id),
				slug: String(svc.slug),
				name: String(svc.name),
				kind: String(svc.kind),
				price_flat: basePrice,
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
