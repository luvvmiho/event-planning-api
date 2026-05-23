import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { supabase } from "../lib/supabase.js"
import { authenticate, requireProvider } from "../middleware/auth.js"

export const timeSlotsRouter = new Hono()

const upsertSlotSchema = z.object({
  day_of_week: z.number().int().min(0).max(6),
  regular_price: z.number().int().min(0),
  sale_price: z.number().int().min(0).nullable().optional(),
  is_on_sale: z.boolean().default(false),
})

timeSlotsRouter.get("/:venueId", async (c) => {
  const venueId = c.req.param("venueId")

  const { data, error } = await supabase
    .from("venue_time_slots")
    .select("*")
    .eq("venue_id", venueId)
    .order("day_of_week")

  if (error) return c.json({ error: error.message }, 500)

  return c.json({ data })
})

timeSlotsRouter.put(
  "/:venueId/:day",
  authenticate,
  requireProvider,
  zValidator("json", upsertSlotSchema),
  async (c) => {
    const venueId = c.req.param("venueId")
    const day = parseInt(c.req.param("day"), 10)
    const user = c.var.user
    const body = c.req.valid("json")

    if (user.role !== "admin") {
      const { data: venue } = await supabase
        .from("venues")
        .select("id")
        .eq("id", venueId)
        .eq("provider_id", user.id)
        .maybeSingle()

      if (!venue) return c.json({ error: "Venue not found or unauthorized" }, 403)
    }

    const { data, error } = await supabase
      .from("venue_time_slots")
      .upsert({ venue_id: venueId, ...body, day_of_week: day }, { onConflict: "venue_id,day_of_week" })
      .select()
      .single()

    if (error) return c.json({ error: error.message }, 400)

    return c.json({ data })
  }
)

timeSlotsRouter.delete("/:venueId/:day", authenticate, requireProvider, async (c) => {
  const venueId = c.req.param("venueId")
  const day = parseInt(c.req.param("day"), 10)
  const user = c.var.user

  if (user.role !== "admin") {
    const { data: venue } = await supabase
      .from("venues")
      .select("id")
      .eq("id", venueId)
      .eq("provider_id", user.id)
      .maybeSingle()

    if (!venue) return c.json({ error: "Venue not found or unauthorized" }, 403)
  }

  const { error } = await supabase
    .from("venue_time_slots")
    .delete()
    .eq("venue_id", venueId)
    .eq("day_of_week", day)

  if (error) return c.json({ error: error.message }, 400)

  return c.json({ success: true })
})
