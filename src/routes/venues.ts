import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { supabase } from "../lib/supabase.js"
import {
  assertVenueOwnerOrAdmin,
  VENUE_STATUSES,
  venueAccessErrorResponse,
} from "../lib/venue-access.js"
import {
  assertScopedProviderVenueAccess,
  authenticate,
  requireProvider,
} from "../middleware/auth.js"
import {
  createPackageBodySchema,
  persistVenuePackage,
  syncVenueEventPackages,
  upsertEventPackageInputSchema,
  venuePackagesRouter,
} from "./venue-packages.js"

export const venuesRouter = new Hono()

const SORT_MAP: Record<string, { column: string; ascending: boolean }> = {
  rating: { column: "rating", ascending: false },
  newest: { column: "created_at", ascending: false },
  price_asc: { column: "price_per_person", ascending: true },
  price_desc: { column: "price_per_person", ascending: false },
  name: { column: "name", ascending: true },
}

const listQuerySchema = z.object({
  category: z.string().optional(),
  categoryId: z.string().uuid().optional(),
  provider_id: z.string().uuid().optional(),
  district: z.string().optional(),
  capacity: z.coerce.number().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  search: z.string().optional(),
  featured: z.coerce.boolean().optional(),
  sort: z.enum(["rating", "newest", "price_asc", "price_desc", "name"]).default("rating"),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(12),
})

const venueIdParamSchema = z.object({
  id: z.string().uuid("Байршлын ID буруу байна"),
})

const patchVenueStatusBodySchema = z.object({
  status: z.enum(VENUE_STATUSES),
})

const emptyToUndef = (v: unknown) => (v === "" || v === null ? undefined : v)

const coordPreprocess = (v: unknown) => emptyToUndef(v)

const venueWritableBodySchema = z.object({
  name: z.string().trim().min(2, "Нэр хэт богино байна"),
  short_description: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
  description: z.preprocess(emptyToUndef, z.string().trim().optional()),
  category_id: z.string().uuid("Ангилал сонгоно уу"),
  location: z.string().trim().min(2, "Байршил оруулна уу"),
  district: z.preprocess(emptyToUndef, z.string().trim().max(200).optional()),
  address: z.preprocess(emptyToUndef, z.string().trim().optional()),
  lat: z.preprocess(coordPreprocess, z.coerce.number().optional()),
  long: z.preprocess(coordPreprocess, z.coerce.number().optional()),
  capacity_min: z.coerce.number().int().min(1),
  capacity_max: z.coerce.number().int().min(1),
  price_per_person: z.coerce.number().int().min(0),
  contact_phone: z.preprocess(emptyToUndef, z.string().trim().max(50).optional()),
  contact_email: z.preprocess(emptyToUndef, z.string().trim().email().optional()),
  website: z.preprocess(emptyToUndef, z.string().trim().url().optional()),
  amenities: z.array(z.string().trim().min(1)).optional(),
  image_url: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
  images: z.array(z.string().trim().max(2000)).max(20).optional(),
  operating_hours: z.record(z.unknown()).optional(),
})

const createVenueBodySchema = venueWritableBodySchema
  .extend({
    /** Optional bundles; created after venue row (rollback venue if any package fails). */
    event_packages: z.array(createPackageBodySchema).max(30).optional(),
  })
  .refine((data) => data.capacity_max >= data.capacity_min, {
    message: "capacity_max must be >= capacity_min",
    path: ["capacity_max"],
  })
  .superRefine((data, ctx) => {
    const { lat, long: lon } = data
    const hasLat = lat != null && Number.isFinite(lat)
    const hasLon = lon != null && Number.isFinite(lon)
    if (hasLat !== hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Өргөрөг, уртрагыг хамтад нь оруулна уу",
        path: ["lat"],
      })
    }
    if (hasLat && (lat! < -90 || lat! > 90)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Өргөрөг -90 … 90 хооронд байна",
        path: ["lat"],
      })
    }
    if (hasLon && (lon! < -180 || lon! > 180)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Уртраг -180 … 180 хооронд байна",
        path: ["long"],
      })
    }
  })

const reviewsListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(20),
})

const createReviewBodySchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
})

const patchVenueBodySchema = venueWritableBodySchema
  .partial()
  .omit({ category_id: true })
  .extend({
    /** Full bundle list for this venue: update by `id`, create without `id`, remove omitted packages. */
    event_packages: z.array(upsertEventPackageInputSchema).max(30).optional(),
  })
  .superRefine((val, ctx) => {
    if (
      val.capacity_min != null &&
      val.capacity_max != null &&
      val.capacity_max < val.capacity_min
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "capacity_max must be >= capacity_min",
        path: ["capacity_max"],
      })
    }
    const anyCoord = val.lat !== undefined || val.long !== undefined
    if (!anyCoord) return
    const lat = val.lat
    const lon = val.long
    const hasLat = lat != null && Number.isFinite(lat)
    const hasLon = lon != null && Number.isFinite(lon)
    if (hasLat !== hasLon) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Өргөрөг, уртрагыг хамтад нь оруулна уу",
        path: ["lat"],
      })
    }
    if (hasLat && (lat! < -90 || lat! > 90)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Өргөрөг -90 … 90 хооронд байна",
        path: ["lat"],
      })
    }
    if (hasLon && (lon! < -180 || lon! > 180)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Уртраг -180 … 180 хооронд байна",
        path: ["long"],
      })
    }
  })

const slugifyAscii = (input: string): string => {
  const s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
  return s
}

const generateUniqueVenueSlug = async (name: string): Promise<string> => {
  let base = slugifyAscii(name)
  if (base.length < 3) base = `venue-${randomUUID().slice(0, 8)}`

  let candidate = base
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data: clash } = await supabase.from("venues").select("id").eq("slug", candidate).maybeSingle()
    if (!clash) return candidate
    candidate = `${base}-${randomUUID().slice(0, 8)}`
  }
  return `${base}-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

venuesRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const {
    category,
    categoryId,
    provider_id,
    district,
    capacity,
    minPrice,
    maxPrice,
    search,
    featured,
    sort,
    page,
    limit,
  } = c.req.valid("query")
  const offset = (page - 1) * limit
  const sortOpt = SORT_MAP[sort]

  if (provider_id) {
    await assertScopedProviderVenueAccess(c.req.header("Authorization"), provider_id)
  }

  let query = supabase
    .from("venues")
    .select(
      "id, slug, name, short_description, location, district, capacity_min, capacity_max, price_per_person, rating, review_count, image_url, images, is_featured, is_new, status, created_at, categories(id, slug, name)",
      { count: "exact" },
    )
    .order(sortOpt.column, { ascending: sortOpt.ascending })
    .eq("status", "published")
    .range(offset, offset + limit - 1)

  if (provider_id) {
    query = query.eq("provider_id", provider_id)
  }

  if (categoryId) {
    query = query.eq("category_id", categoryId)
  } else if (category) {
    const { data: cat } = await supabase.from("categories").select("id").eq("slug", category).maybeSingle()
    if (cat?.id) query = query.eq("category_id", cat.id)
  }

  if (district) query = query.ilike("district", `%${district}%`)
  if (capacity) query = query.lte("capacity_min", capacity).gte("capacity_max", capacity)
  if (minPrice != null) query = query.gte("price_per_person", minPrice)
  if (maxPrice != null) query = query.lte("price_per_person", maxPrice)
  if (featured) query = query.eq("is_featured", true)
  if (search) {
    query = query.or(`name.ilike.%${search}%,description.ilike.%${search}%,location.ilike.%${search}%`)
  }

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

venuesRouter.post("/", authenticate, requireProvider, zValidator("json", createVenueBodySchema), async (c) => {
  const user = c.var.user
  const body = c.req.valid("json")

  const slug = await generateUniqueVenueSlug(body.name)

  const lat = body.lat != null && Number.isFinite(body.lat) ? body.lat : null
  const long = body.long != null && Number.isFinite(body.long) ? body.long : null

  const row = {
    slug,
    provider_id: user.id,
    category_id: body.category_id,
    name: body.name,
    short_description: body.short_description ?? null,
    description: body.description ?? null,
    location: body.location,
    district: body.district ?? null,
    address: body.address ?? null,
    lat,
    long,
    capacity_min: body.capacity_min,
    capacity_max: body.capacity_max,
    price_per_person: body.price_per_person,
    contact_phone: body.contact_phone ?? null,
    contact_email: body.contact_email ?? null,
    website: body.website ?? null,
    amenities: body.amenities?.length ? body.amenities : null,
    image_url: body.image_url ?? null,
    images: body.images ?? null,
    operating_hours: body.operating_hours ?? {},
    is_new: true,
    status: "draft" as const,
  }

  const { data, error } = await supabase.from("venues").insert(row).select("*, categories(slug, name)").single()

  if (error || !data) {
    console.error("venues insert", error)
    return c.json({ error: error?.message ?? "Insert failed" }, 400)
  }

  const venueId = typeof data.id === "string" ? data.id : String(data.id)

  const toCreate = body.event_packages ?? []
  const event_packages: Record<string, unknown>[] = []

  if (toCreate.length > 0) {
    for (const pkgBody of toCreate) {
      const persisted = await persistVenuePackage(venueId, pkgBody)
      if (!persisted.ok) {
        await supabase.from("venues").delete().eq("id", venueId)
        return c.json({ error: persisted.error }, persisted.statusCode)
      }
      event_packages.push(persisted.data)
    }
  }

  return c.json({ data: { ...data, event_packages } }, 201)
})

venuesRouter.route("/", venuePackagesRouter)

venuesRouter.get("/:id/reviews", zValidator("query", reviewsListQuerySchema), async (c) => {
  const venueId = c.req.param("id")
  if (!z.string().uuid().safeParse(venueId).success) {
    return c.json({ error: "Байршлын ID буруу байна" }, 400)
  }

  const { page, limit } = c.req.valid("query")
  const offset = (page - 1) * limit

  const { data: venue } = await supabase.from("venues").select("id").eq("id", venueId).maybeSingle()
  if (!venue) return c.json({ error: "Venue not found" }, 404)

  const { data, error, count } = await supabase
    .from("venue_reviews")
    .select("id, rating, comment, created_at, updated_at, user_id, profiles(full_name)", { count: "exact" })
    .eq("venue_id", venueId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

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

venuesRouter.post("/:id/reviews", authenticate, zValidator("json", createReviewBodySchema), async (c) => {
  const venueId = c.req.param("id")
  if (!z.string().uuid().safeParse(venueId).success) {
    return c.json({ error: "Байршлын ID буруу байна" }, 400)
  }

  const user = c.var.user
  const { rating, comment } = c.req.valid("json")

  const { data: venue } = await supabase.from("venues").select("id").eq("id", venueId).maybeSingle()
  if (!venue) return c.json({ error: "Venue not found" }, 404)

  const { data, error } = await supabase
    .from("venue_reviews")
    .upsert(
      {
        venue_id: venueId,
        user_id: user.id,
        rating,
        comment: comment ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "venue_id,user_id" },
    )
    .select("id, rating, comment, created_at, updated_at, user_id, profiles(full_name)")
    .single()

  if (error) {
    console.error("venue_reviews upsert", error)
    const msg = error.code === "23503" ? "Профайл олдсонгүй. Дахин нэвтэрнэ үү." : error.message
    return c.json({ error: msg }, 400)
  }

  return c.json({ data }, 201)
})

/** Provider/admin — full venue by UUID (any status). */
venuesRouter.get(
  "/:id/manage",
  authenticate,
  requireProvider,
  zValidator("param", venueIdParamSchema),
  async (c) => {
    const { id: venueId } = c.req.valid("param")
    const user = c.var.user

    try {
      await assertVenueOwnerOrAdmin(user, venueId)
    } catch (e) {
      const { message, status } = venueAccessErrorResponse(e)
      return c.json({ error: message }, status)
    }

    const { data, error } = await supabase
      .from("venues")
      .select("*, categories(slug, name)")
      .eq("id", venueId)
      .maybeSingle()

    if (error) return c.json({ error: error.message }, 500)
    if (!data) return c.json({ error: "Venue not found" }, 404)

    const packageServiceSelect =
      "id, package_id, kind, title, description, quantity, is_included, sort_order, provider_service_id, provider_services (id, slug, name, kind, price_flat, image_url)"

    const [{ data: event_packages }, { data: provider_services }] = await Promise.all([
      supabase
        .from("venue_event_packages")
        .select(
          `id, venue_id, slug, name, short_description, price_flat, guests_min, guests_max, sort_order, is_active, created_at, updated_at, venue_package_services (${packageServiceSelect})`,
        )
        .eq("venue_id", venueId)
        .order("sort_order", { ascending: true }),
      supabase
        .from("provider_services")
        .select("id, slug, name, kind, price_flat, status, image_url, sort_order")
        .eq("provider_id", data.provider_id)
        .order("sort_order", { ascending: true }),
    ])

    return c.json({
      data: {
        ...data,
        event_packages: event_packages ?? [],
        provider_services: provider_services ?? [],
      },
    })
  },
)

venuesRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug")

  const { data, error } = await supabase
    .from("venues")
    .select("*, categories(slug, name)")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: "Venue not found" }, 404)

  return c.json({ data })
})

venuesRouter.get("/:id/availability", async (c) => {
  const venueId = c.req.param("id")
  if (!z.string().uuid().safeParse(venueId).success) {
    return c.json({ error: "Байршлын ID буруу байна" }, 400)
  }

  const { data: venue } = await supabase
    .from("venues")
    .select("id")
    .eq("id", venueId)
    .eq("status", "published")
    .maybeSingle()
  if (!venue) return c.json({ error: "Venue not found" }, 404)

  const month = c.req.query("month")

  let startDate: string
  let endDate: string

  if (month) {
    const [year, mon] = month.split("-").map(Number)
    startDate = new Date(year, mon - 1, 1).toISOString().split("T")[0]
    endDate = new Date(year, mon, 0).toISOString().split("T")[0]
  } else {
    const now = new Date()
    startDate = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0]
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0]
  }

  const { data: slots, error: slotsErr } = await supabase
    .from("venue_time_slots")
    .select("*")
    .eq("venue_id", venueId)

  if (slotsErr) {
    return c.json({ error: slotsErr.message }, 500)
  }

  const { data: bookedRows, error: bookedErr } = await supabase
    .from("venue_booked_dates")
    .select("booking_date")
    .eq("venue_id", venueId)
    .gte("booking_date", startDate)
    .lte("booking_date", endDate)

  if (bookedErr) {
    return c.json({ error: bookedErr.message }, 500)
  }

  const bookedDates = [
    ...new Set(
      (bookedRows ?? []).map((r) => {
        const d = r.booking_date as string
        return d.length >= 10 ? d.slice(0, 10) : d
      }),
    ),
  ].sort()

  return c.json({ data: { slots, startDate, endDate, bookedDates } })
})

venuesRouter.patch(
  "/:id/status",
  authenticate,
  requireProvider,
  zValidator("param", venueIdParamSchema),
  zValidator("json", patchVenueStatusBodySchema),
  async (c) => {
    const { id: venueId } = c.req.valid("param")
    const { status } = c.req.valid("json")
    const user = c.var.user

    try {
      await assertVenueOwnerOrAdmin(user, venueId)
    } catch (e) {
      const { message, status: httpStatus } = venueAccessErrorResponse(e)
      return c.json({ error: message }, httpStatus)
    }

    let qb = supabase
      .from("venues")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", venueId)
    if (user.role !== "admin") {
      qb = qb.eq("provider_id", user.id)
    }

    const { data, error } = await qb.select("*, categories(slug, name)").maybeSingle()

    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Venue not found or unauthorized" }, 404)

    return c.json({ data })
  },
)

venuesRouter.delete(
  "/:id",
  authenticate,
  requireProvider,
  zValidator("param", venueIdParamSchema),
  async (c) => {
    const { id: venueId } = c.req.valid("param")
    const user = c.var.user

    try {
      await assertVenueOwnerOrAdmin(user, venueId)
    } catch (e) {
      const { message, status } = venueAccessErrorResponse(e)
      return c.json({ error: message }, status)
    }

    let qb = supabase.from("venues").delete().eq("id", venueId)
    if (user.role !== "admin") {
      qb = qb.eq("provider_id", user.id)
    }

    const { data, error } = await qb.select("id, slug, name").maybeSingle()

    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Venue not found or unauthorized" }, 404)

    return c.json({ data: { deleted: true, id: data.id, slug: data.slug, name: data.name } })
  },
)

venuesRouter.patch(
  "/:id",
  authenticate,
  requireProvider,
  zValidator("param", venueIdParamSchema),
  zValidator("json", patchVenueBodySchema),
  async (c) => {
  const { id: venueId } = c.req.valid("param")
  const user = c.var.user
  const body = c.req.valid("json")

  try {
    await assertVenueOwnerOrAdmin(user, venueId)
  } catch (e) {
    const { message, status } = venueAccessErrorResponse(e)
    return c.json({ error: message }, status)
  }

  const { event_packages: eventPackagesPayload, ...venuePatch } = body

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const [key, val] of Object.entries(venuePatch)) {
    if (key === "lat" || key === "long") continue
    if (val !== undefined) updates[key] = val
  }

  if (body.lat !== undefined) {
    updates.lat = body.lat != null && Number.isFinite(body.lat) ? body.lat : null
  }
  if (body.long !== undefined) {
    updates.long = body.long != null && Number.isFinite(body.long) ? body.long : null
  }

  if (updates.website === "") updates.website = null
  if ("amenities" in updates && Array.isArray(updates.amenities) && (updates.amenities as string[]).length === 0) {
    updates.amenities = null
  }

  delete updates.slug
  delete updates.provider_id
  delete updates.category_id
  delete updates.rating
  delete updates.review_count
  delete updates.status

  const hasVenueFieldUpdates = Object.keys(updates).filter((k) => k !== "updated_at").length > 0
  const hasPackageUpdates = eventPackagesPayload !== undefined

  if (!hasVenueFieldUpdates && !hasPackageUpdates) {
    return c.json({ error: "Шинэчлэх талбар алга байна" }, 400)
  }

  let venueRow: Record<string, unknown> | null = null

  if (hasVenueFieldUpdates) {
    let qb = supabase.from("venues").update(updates).eq("id", venueId)
    if (user.role !== "admin") {
      qb = qb.eq("provider_id", user.id)
    }

    const { data, error } = await qb.select("*, categories(slug, name)").maybeSingle()

    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Venue not found or unauthorized" }, 404)
    venueRow = data as Record<string, unknown>
  } else {
    const { data, error } = await supabase
      .from("venues")
      .select("*, categories(slug, name)")
      .eq("id", venueId)
      .maybeSingle()
    if (error) return c.json({ error: error.message }, 500)
    if (!data) return c.json({ error: "Venue not found or unauthorized" }, 404)
    venueRow = data as Record<string, unknown>
  }

  let event_packages: Record<string, unknown>[] | undefined
  if (hasPackageUpdates) {
    const synced = await syncVenueEventPackages(venueId, eventPackagesPayload)
    if (!synced.ok) return c.json({ error: synced.error }, synced.statusCode)
    event_packages = synced.data
  } else {
    const { data: pkgs } = await supabase
      .from("venue_event_packages")
      .select(
        "id, venue_id, slug, name, short_description, price_flat, guests_min, guests_max, sort_order, is_active, created_at, updated_at, venue_package_services (*)",
      )
      .eq("venue_id", venueId)
      .order("sort_order", { ascending: true })
    event_packages = (pkgs ?? []) as Record<string, unknown>[]
  }

  return c.json({ data: { ...venueRow, event_packages } })
  },
)
