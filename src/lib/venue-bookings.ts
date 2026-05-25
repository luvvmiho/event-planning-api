import { z } from 'zod';
import { supabase } from './supabase.js';

const BOOKED_STATUSES = new Set(['paid']);

type OrderItemLike = {
	venueId?: string;
	bookingDate?: string;
};

const parseItems = (items: unknown): OrderItemLike[] => (Array.isArray(items) ? items : []) as OrderItemLike[];

export async function syncVenueBookingsForOrder(
	orderId: string,
	items: unknown,
	status: string,
): Promise<void> {
	await supabase.from('venue_booked_dates').delete().eq('order_id', orderId);

	if (!BOOKED_STATUSES.has(status)) return;

	const rows: { order_id: string; venue_id: string; booking_date: string }[] = [];

	for (const item of parseItems(items)) {
		const vid = item.venueId?.trim();
		const bd = item.bookingDate?.trim();
		if (!vid || !bd) continue;
		if (!z.string().uuid().safeParse(vid).success) continue;
		if (!/^\d{4}-\d{2}-\d{2}$/.test(bd)) continue;
		rows.push({ order_id: orderId, venue_id: vid, booking_date: bd });
	}

	if (rows.length === 0) return;

	const { error } = await supabase.from('venue_booked_dates').insert(rows);

	if (error) {
		console.error('venue_booked_dates sync', orderId, error);
	}
}
