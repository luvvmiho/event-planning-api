import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { supabase } from "../../lib/supabase.js"
import { authenticate, mapSupabaseUserToAuthUser, requireAdmin } from "../../middleware/auth.js"

export const adminProvidersRouter = new Hono()

adminProvidersRouter.use("*", authenticate, requireAdmin)

adminProvidersRouter.get("/", async (c) => {
  const {
    data: { users },
    error,
  } = await supabase.auth.admin.listUsers()

  if (error) return c.json({ error: error.message }, 500)

  const providers = users.filter((u) => mapSupabaseUserToAuthUser(u).role === "provider")

  const providerIds = providers.map((p) => p.id)
  const { data: venues } = await supabase
    .from("venues")
    .select("id, provider_id, name, slug, is_featured")
    .in("provider_id", providerIds)

  const result = providers.map((p) => ({
    id: p.id,
    email: p.email,
    created_at: p.created_at,
    verified: p.app_metadata?.provider_verified ?? false,
    venues: (venues ?? []).filter((v) => v.provider_id === p.id),
  }))

  return c.json({ data: result })
})

adminProvidersRouter.get("/:id", async (c) => {
  const providerId = c.req.param("id")

  const {
    data: { user },
    error,
  } = await supabase.auth.admin.getUserById(providerId)

  if (error || !user) return c.json({ error: "Provider not found" }, 404)

  const { data: venues } = await supabase
    .from("venues")
    .select("id, name, slug, rating, review_count, price_per_person, is_featured, created_at")
    .eq("provider_id", providerId)

  const venueIds = new Set((venues ?? []).map((v) => v.id))

  const { data: orderCandidates } = await supabase
    .from("orders")
    .select("id, status, total, items, created_at")
    .order("created_at", { ascending: false })
    .limit(300)

  const recentOrders = (orderCandidates ?? [])
    .filter((o) => {
      const raw = o.items
      const items = Array.isArray(raw) ? raw : []
      return items.some((it: unknown) => {
        if (typeof it !== "object" || it === null || !("venueId" in it)) return false
        const vid = (it as { venueId: unknown }).venueId
        return typeof vid === "string" && venueIds.has(vid)
      })
    })
    .slice(0, 50)

  return c.json({
    data: {
      id: user.id,
      email: user.email,
      created_at: user.created_at,
      verified: user.app_metadata?.provider_verified ?? false,
      venues: venues ?? [],
      recentOrders,
    },
  })
})

adminProvidersRouter.patch(
  "/:id/verify",
  zValidator("json", z.object({ verified: z.boolean() })),
  async (c) => {
    const providerId = c.req.param("id")
    const { verified } = c.req.valid("json")

    const {
      data: { user },
      error,
    } = await supabase.auth.admin.updateUserById(providerId, {
      app_metadata: { role: "provider", provider_verified: verified },
    })

    if (error || !user) return c.json({ error: error?.message ?? "Update failed" }, 400)

    return c.json({
      data: {
        id: user.id,
        email: user.email,
        verified,
      },
    })
  }
)

adminProvidersRouter.patch(
  "/:id/role",
  zValidator("json", z.object({ role: z.enum(["customer", "provider", "admin"]) })),
  async (c) => {
    const userId = c.req.param("id")
    const { role } = c.req.valid("json")

    const {
      data: { user },
      error,
    } = await supabase.auth.admin.updateUserById(userId, {
      app_metadata: { role },
    })

    if (error || !user) return c.json({ error: error?.message ?? "Update failed" }, 400)

    return c.json({ data: { id: user.id, email: user.email, role } })
  }
)
