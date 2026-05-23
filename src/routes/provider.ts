import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { z } from "zod"
import { supabase } from "../lib/supabase.js"
import {
	displayOrderRef,
	eventTypeLabelForProvider,
	calendarMonthBoundsUtc,
	fetchRecentOrders,
	getProviderServiceIds,
	getProviderVenueIds,
	orderTouchesProvider,
	pctChange,
	providerShareFromOrder,
	type OrderRow,
} from "../lib/provider-orders.js"
import { syncVenueBookingsForOrder } from "../lib/venue-bookings.js"
import { authenticate, requireProvider } from "../middleware/auth.js"

export const providerRouter = new Hono()

providerRouter.use("*", authenticate, requireProvider)

const listQuerySchema = z.object({
	page: z.coerce.number().min(1).default(1),
	limit: z.coerce.number().min(1).max(100).default(20),
	status: z.enum(["pending", "paid", "cancelled"]).optional(),
})

const orderIdParam = z.object({ id: z.string().uuid() })

const MAX_ORDER_SCAN = 4000

providerRouter.get("/stats", async (c) => {
	const user = c.var.user
	const venueIdsArr = await getProviderVenueIds(user.id)
	const serviceIdsArr = await getProviderServiceIds(user.id)
	const venueIdSet = new Set(venueIdsArr)
	const serviceIdSet = new Set(serviceIdsArr)

	const [{ count: venueCount }, { count: serviceCount }] = await Promise.all([
		supabase.from("venues").select("id", { count: "exact", head: true }).eq("provider_id", user.id),
		supabase
			.from("provider_services")
			.select("id", { count: "exact", head: true })
			.eq("provider_id", user.id),
	])
	const activeServices = (venueCount ?? 0) + (serviceCount ?? 0)

	const orders = await fetchRecentOrders(MAX_ORDER_SCAN)
	const mine = orders.filter((o) => orderTouchesProvider(o, venueIdSet, serviceIdSet))

	let totalRevenue = 0
	for (const o of mine) {
		if (o.status === "paid") totalRevenue += providerShareFromOrder(o, venueIdSet, serviceIdSet)
	}

	const thisMonth = calendarMonthBoundsUtc(0)
	const lastMonth = calendarMonthBoundsUtc(1)

	let thisMonthOrders = 0
	let lastMonthOrders = 0
	let thisMonthRev = 0
	let lastMonthRev = 0

	for (const o of mine) {
		const d = new Date(o.created_at)
		if (d >= thisMonth.start && d < thisMonth.end) {
			thisMonthOrders += 1
			if (o.status === "paid") thisMonthRev += providerShareFromOrder(o, venueIdSet, serviceIdSet)
		} else if (d >= lastMonth.start && d < lastMonth.end) {
			lastMonthOrders += 1
			if (o.status === "paid") lastMonthRev += providerShareFromOrder(o, venueIdSet, serviceIdSet)
		}
	}

	return c.json({
		data: {
			totalOrders: mine.length,
			totalRevenue,
			activeServices,
			ordersTrendPercent: pctChange(thisMonthOrders, lastMonthOrders),
			revenueTrendPercent: pctChange(thisMonthRev, lastMonthRev),
		},
	})
})

providerRouter.get("/orders", zValidator("query", listQuerySchema), async (c) => {
	const user = c.var.user
	const { page, limit, status } = c.req.valid("query")
	const venueIdSet = new Set(await getProviderVenueIds(user.id))
	const serviceIdSet = new Set(await getProviderServiceIds(user.id))

	if (venueIdSet.size === 0 && serviceIdSet.size === 0) {
		return c.json({
			data: [],
			meta: { total: 0, page, limit, totalPages: 0 },
		})
	}

	const orders = await fetchRecentOrders(MAX_ORDER_SCAN)
	let mine = orders.filter((o) => orderTouchesProvider(o, venueIdSet, serviceIdSet))
	if (status) mine = mine.filter((o) => o.status === status)

	const total = mine.length
	const offset = (page - 1) * limit
	const pageRows = mine.slice(offset, offset + limit)

	const data = pageRows.map((o) => ({
		id: o.id,
		display_ref: displayOrderRef(o.id),
		customer_name: o.customer_name,
		event_type_label: eventTypeLabelForProvider(o, venueIdSet, serviceIdSet),
		created_at: o.created_at,
		status: o.status,
		total: o.total,
		provider_subtotal: providerShareFromOrder(o, venueIdSet, serviceIdSet),
	}))

	return c.json({
		data,
		meta: {
			total,
			page,
			limit,
			totalPages: Math.ceil(total / limit),
		},
	})
})

providerRouter.get("/orders/:id", zValidator("param", orderIdParam), async (c) => {
	const user = c.var.user
	const { id } = c.req.valid("param")
	const venueIdSet = new Set(await getProviderVenueIds(user.id))
	const serviceIdSet = new Set(await getProviderServiceIds(user.id))

	if (venueIdSet.size === 0 && serviceIdSet.size === 0) return c.json({ error: "Захиалга олдсонгүй" }, 404)

	const { data, error } = await supabase
		.from("orders")
		.select("*")
		.eq("id", id)
		.maybeSingle()

	if (error) {
		console.error("provider order detail", error)
		return c.json({ error: "Захиалга ачааллаагүй байна" }, 500)
	}
	if (!data) return c.json({ error: "Захиалга олдсонгүй" }, 404)

	const row = data as OrderRow
	if (!orderTouchesProvider(row, venueIdSet, serviceIdSet)) return c.json({ error: "Захиалга олдсонгүй" }, 404)

	return c.json({
		data: {
			...row,
			display_ref: displayOrderRef(row.id),
			event_type_label: eventTypeLabelForProvider(row, venueIdSet, serviceIdSet),
			provider_subtotal: providerShareFromOrder(row, venueIdSet, serviceIdSet),
		},
	})
})

providerRouter.patch(
	"/orders/:id/status",
	zValidator("param", orderIdParam),
	zValidator("json", z.object({ status: z.enum(["pending", "paid", "cancelled"]) })),
	async (c) => {
		const user = c.var.user
		const { id } = c.req.valid("param")
		const { status } = c.req.valid("json")
		const venueIdSet = new Set(await getProviderVenueIds(user.id))
		const serviceIdSet = new Set(await getProviderServiceIds(user.id))

		if (venueIdSet.size === 0 && serviceIdSet.size === 0) return c.json({ error: "Захиалга олдсонгүй" }, 404)

		const { data: existing, error: loadErr } = await supabase
			.from("orders")
			.select("*")
			.eq("id", id)
			.maybeSingle()

		if (loadErr) {
			console.error("provider order status load", loadErr)
			return c.json({ error: "Захиалга ачааллаагүй байна" }, 500)
		}
		if (!existing) return c.json({ error: "Захиалга олдсонгүй" }, 404)

		const row = existing as OrderRow
		if (!orderTouchesProvider(row, venueIdSet, serviceIdSet)) return c.json({ error: "Захиалга олдсонгүй" }, 404)

		const { data: updated, error: upErr } = await supabase
			.from("orders")
			.update({ status })
			.eq("id", id)
			.select("*")
			.single()

		if (upErr) {
			console.error("provider order status update", upErr)
			return c.json({ error: "Төлөв шинэчлэгдээгүй байна" }, 400)
		}

		const out = updated as OrderRow
		await syncVenueBookingsForOrder(out.id, out.items, out.status)
		return c.json({
			data: {
				...out,
				display_ref: displayOrderRef(out.id),
				event_type_label: eventTypeLabelForProvider(out, venueIdSet, serviceIdSet),
				provider_subtotal: providerShareFromOrder(out, venueIdSet, serviceIdSet),
			},
		})
	},
)
