import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { supabase } from "../../lib/supabase.js"
import { syncVenueBookingsForOrder } from "../../lib/venue-bookings.js"
import { authenticate, requireAdmin } from "../../middleware/auth.js"

export const adminOrdersRouter = new Hono()

adminOrdersRouter.use("*", authenticate, requireAdmin)

const listQuerySchema = z.object({
  status: z.enum(["pending", "paid", "cancelled"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
})

adminOrdersRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { status, from, to, page, limit } = c.req.valid("query")
  const offset = (page - 1) * limit

  let query = supabase
    .from("orders")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (status) query = query.eq("status", status)
  if (from) query = query.gte("created_at", from)
  if (to) query = query.lte("created_at", to)

  const { data, error, count } = await query

  if (error) return c.json({ error: error.message }, 500)

  return c.json({
    data,
    meta: {
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  })
})

adminOrdersRouter.get("/stats", async (c) => {
  const [pending, paidCount, cancelled, revenue] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "paid"),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "cancelled"),
    supabase.from("orders").select("total").eq("status", "paid"),
  ])

  const totalRevenue = (revenue.data ?? []).reduce((sum, o) => sum + (Number(o.total) || 0), 0)

  return c.json({
    data: {
      pending: pending.count ?? 0,
      paid: paidCount.count ?? 0,
      cancelled: cancelled.count ?? 0,
      totalRevenue,
    },
  })
})

adminOrdersRouter.patch(
  "/:id",
  zValidator("json", z.object({ status: z.enum(["pending", "paid", "cancelled"]) })),
  async (c) => {
    const orderId = c.req.param("id")
    const { status } = c.req.valid("json")

    const { data, error } = await supabase.from("orders").update({ status }).eq("id", orderId).select().single()

    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Order not found" }, 404)

    await syncVenueBookingsForOrder(data.id, data.items, data.status)

    return c.json({ data })
  },
)
