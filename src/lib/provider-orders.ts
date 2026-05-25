import { supabase } from "./supabase.js"
import { isServiceOrderItem, parseOrderItems, type OrderItemJson } from "./order-items.js"

export type OrderRow = {
	id: string
	user_id: string | null
	customer_name: string
	customer_email: string
	customer_phone: string
	payment_method: string
	notes: string | null
	items: unknown
	subtotal: number
	total: number
	status: string
	created_at: string
}

export const getProviderVenueIds = async (providerId: string): Promise<string[]> => {
	const { data, error } = await supabase.from("venues").select("id").eq("provider_id", providerId)

	if (error) {
		console.error("provider venues", error)
		return []
	}

	return (data ?? []).map((r) => r.id as string)
}

export const getProviderServiceIds = async (providerId: string): Promise<string[]> => {
	const { data, error } = await supabase
		.from("provider_services")
		.select("id")
		.eq("provider_id", providerId)

	if (error) {
		console.error("provider services", error)
		return []
	}

	return (data ?? []).map((r) => r.id as string)
}

export const orderTouchesProvider = (
	order: Pick<OrderRow, "items">,
	venueIds: Set<string>,
	serviceIds: Set<string>,
): boolean => {
	if (venueIds.size === 0 && serviceIds.size === 0) return false
	return parseOrderItems(order.items).some((i) => {
		if (isServiceOrderItem(i)) return i.serviceId != null && serviceIds.has(i.serviceId)
		return i.venueId != null && venueIds.has(i.venueId)
	})
}

export const orderTouchesVenues = (order: Pick<OrderRow, "items">, venueIds: Set<string>): boolean =>
	orderTouchesProvider(order, venueIds, new Set())

export const providerShareFromOrder = (
	order: Pick<OrderRow, "items">,
	venueIds: Set<string>,
	serviceIds: Set<string> = new Set(),
): number => {
	return parseOrderItems(order.items)
		.filter((i) => {
			if (isServiceOrderItem(i)) return i.serviceId != null && serviceIds.has(i.serviceId)
			return i.venueId != null && venueIds.has(i.venueId)
		})
		.reduce((s, i) => s + (Number(i.price) || 0), 0)
}

export const eventTypeLabelForProvider = (
	order: Pick<OrderRow, "items">,
	venueIds: Set<string>,
	serviceIds: Set<string> = new Set(),
): string => {
	const hit = parseOrderItems(order.items).find((i) => {
		if (isServiceOrderItem(i)) return i.serviceId != null && serviceIds.has(i.serviceId)
		return i.venueId != null && venueIds.has(i.venueId)
	})
	return hit?.categoryLabel?.trim() || hit?.name?.trim() || "—"
}

export const displayOrderRef = (id: string): string => {
	const compact = id.replace(/-/g, "").toUpperCase()
	return `#NR-${compact.slice(-6)}`
}

export const calendarMonthBoundsUtc = (monthsAgo: number): { start: Date; end: Date } => {
	const now = new Date()
	const y = now.getUTCFullYear()
	const m = now.getUTCMonth() - monthsAgo
	const start = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0))
	const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0))
	return { start, end }
}

export const pctChange = (current: number, previous: number): number | null => {
	if (previous === 0) return current > 0 ? null : 0
	return Math.round(((current - previous) / previous) * 1000) / 10
}

export const fetchRecentOrders = async (maxRows: number): Promise<OrderRow[]> => {
	const { data, error } = await supabase
		.from("orders")
		.select(
			"id, user_id, customer_name, customer_email, customer_phone, payment_method, notes, items, subtotal, total, status, created_at",
		)
		.order("created_at", { ascending: false })
		.limit(maxRows)

	if (error) {
		console.error("orders fetch for provider", error)
		return []
	}

	return (data ?? []) as OrderRow[]
}
