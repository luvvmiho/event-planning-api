import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { supabase } from "../lib/supabase.js"
import {
  assertServiceOwnerOrAdmin,
  SERVICE_KINDS,
  SERVICE_STATUSES,
  serviceAccessErrorResponse,
} from "../lib/service-access.js"
import {
  assertScopedProviderVenueAccess,
  authenticate,
  requireProvider,
} from "../middleware/auth.js"

export const servicesRouter = new Hono()

const emptyToUndef = (v: unknown) => (v === "" || v === null ? undefined : v)

const serviceBodySchema = z.object({
  name: z.string().trim().min(2),
  kind: z.enum(SERVICE_KINDS),
  short_description: z.preprocess(emptyToUndef, z.string().trim().max(1000).optional()),
  description: z.preprocess(emptyToUndef, z.string().trim().max(10000).optional()),
  price_flat: z.coerce.number().int().min(0),
  location: z.preprocess(emptyToUndef, z.string().trim().max(500).optional()),
  image_url: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
  images: z.array(z.string().trim().max(2000)).max(20).optional(),
  sort_order: z.coerce.number().int().optional().default(0),
  slug: z.preprocess(
    emptyToUndef,
    z
      .string()
      .trim()
      .regex(/^[a-z0-9-]+$/)
      .min(2)
      .max(96)
      .optional(),
  ),
})

const createServiceBodySchema = serviceBodySchema

const patchServiceBodySchema = serviceBodySchema.partial().refine(
  (b) =>
    b.name !== undefined ||
    b.kind !== undefined ||
    b.short_description !== undefined ||
    b.description !== undefined ||
    b.price_flat !== undefined ||
    b.location !== undefined ||
    b.image_url !== undefined ||
    b.images !== undefined ||
    b.sort_order !== undefined ||
    b.slug !== undefined,
  { message: "Шинэчлэх талбар оруулна уу" },
)

const listQuerySchema = z.object({
  kind: z.enum(SERVICE_KINDS).optional(),
  provider_id: z.string().uuid().optional(),
  search: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(50).default(12),
})

const serviceIdParamSchema = z.object({
  id: z.string().uuid("Үйлчилгээний ID буруу байна"),
})

const patchServiceStatusBodySchema = z.object({
  status: z.enum(SERVICE_STATUSES),
})

const SERVICE_SELECT_PUBLIC =
  "id, provider_id, slug, name, kind, short_description, price_flat, location, image_url, images, sort_order, created_at"

const SERVICE_SELECT_DETAIL = SERVICE_SELECT_PUBLIC + ", description, status, updated_at"

const slugifyAscii = (input: string): string => {
  const s = input
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72)
  return s || `svc-${randomUUID().slice(0, 8)}`
}

const generateUniqueServiceSlug = async (baseName: string): Promise<string> => {
  let base = slugifyAscii(baseName)
  if (base.length < 2) base = `svc-${randomUUID().slice(0, 8)}`

  let candidate = base
  for (let attempt = 0; attempt < 24; attempt++) {
    const { data: clash } = await supabase
      .from("provider_services")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle()
    if (!clash) return candidate
    candidate = `${base}-${randomUUID().slice(0, 8)}`
  }
  return `${base}-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

/** Public catalog — published only. */
servicesRouter.get("/", zValidator("query", listQuerySchema), async (c) => {
  const { kind, provider_id, search, page, limit } = c.req.valid("query")
  const offset = (page - 1) * limit

  if (provider_id) {
    await assertScopedProviderVenueAccess(c.req.header("Authorization"), provider_id)
  }

  let query = supabase
    .from("provider_services")
    .select(SERVICE_SELECT_PUBLIC, { count: "exact" })
    .eq("status", "published")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1)

  if (provider_id) query = query.eq("provider_id", provider_id)
  if (kind) query = query.eq("kind", kind)
  if (search) {
    query = query.or(
      `name.ilike.%${search}%,short_description.ilike.%${search}%,description.ilike.%${search}%`,
    )
  }

  const { data, error, count } = await query
  if (error) return c.json({ error: error.message }, 500)

  return c.json({
    data: data ?? [],
    meta: {
      total: count ?? 0,
      page,
      limit,
      totalPages: Math.ceil((count ?? 0) / limit),
    },
  })
})

/** Provider — all own services (any status). */
servicesRouter.get("/manage", authenticate, requireProvider, async (c) => {
  const user = c.var.user

  const { data, error } = await supabase
    .from("provider_services")
    .select(SERVICE_SELECT_DETAIL)
    .eq("provider_id", user.id)
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: false })

  if (error) return c.json({ error: error.message }, 500)
  return c.json({ data: data ?? [] })
})

servicesRouter.post("/", authenticate, requireProvider, zValidator("json", createServiceBodySchema), async (c) => {
  const user = c.var.user
  const body = c.req.valid("json")

  const slug =
    body.slug != null && body.slug.trim().length > 0
      ? body.slug.trim()
      : await generateUniqueServiceSlug(body.name)

  const row = {
    provider_id: user.id,
    slug,
    name: body.name.trim(),
    kind: body.kind,
    short_description: body.short_description ?? null,
    description: body.description ?? null,
    price_flat: body.price_flat,
    location: body.location ?? null,
    image_url: body.image_url ?? null,
    images: body.images ?? [],
    sort_order: body.sort_order,
    status: "draft" as const,
    updated_at: new Date().toISOString(),
  }

  const { data, error } = await supabase.from("provider_services").insert(row).select(SERVICE_SELECT_DETAIL).single()

  if (error) {
    if (error.code === "23505") return c.json({ error: "Slug already exists" }, 409)
    return c.json({ error: error.message }, 400)
  }

  return c.json({ data }, 201)
})

servicesRouter.get(
  "/:id/manage",
  authenticate,
  requireProvider,
  zValidator("param", serviceIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const user = c.var.user

    try {
      await assertServiceOwnerOrAdmin(user, id)
    } catch (e) {
      const { message, status } = serviceAccessErrorResponse(e)
      return c.json({ error: message }, status)
    }

    const { data, error } = await supabase
      .from("provider_services")
      .select(SERVICE_SELECT_DETAIL)
      .eq("id", id)
      .maybeSingle()

    if (error) return c.json({ error: error.message }, 500)
    if (!data) return c.json({ error: "Service not found" }, 404)
    return c.json({ data })
  },
)

servicesRouter.patch(
  "/:id/status",
  authenticate,
  requireProvider,
  zValidator("param", serviceIdParamSchema),
  zValidator("json", patchServiceStatusBodySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const { status } = c.req.valid("json")
    const user = c.var.user

    try {
      await assertServiceOwnerOrAdmin(user, id)
    } catch (e) {
      const { message, status: httpStatus } = serviceAccessErrorResponse(e)
      return c.json({ error: message }, httpStatus)
    }

    let qb = supabase
      .from("provider_services")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", id)
    if (user.role !== "admin") qb = qb.eq("provider_id", user.id)

    const { data, error } = await qb.select(SERVICE_SELECT_DETAIL).maybeSingle()
    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Service not found or unauthorized" }, 404)
    return c.json({ data })
  },
)

servicesRouter.delete(
  "/:id",
  authenticate,
  requireProvider,
  zValidator("param", serviceIdParamSchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const user = c.var.user

    try {
      await assertServiceOwnerOrAdmin(user, id)
    } catch (e) {
      const { message, status } = serviceAccessErrorResponse(e)
      return c.json({ error: message }, status)
    }

    let qb = supabase.from("provider_services").delete().eq("id", id)
    if (user.role !== "admin") qb = qb.eq("provider_id", user.id)

    const { data, error } = await qb.select("id, slug, name").maybeSingle()
    if (error) return c.json({ error: error.message }, 400)
    if (!data) return c.json({ error: "Service not found or unauthorized" }, 404)

    return c.json({ data: { deleted: true, id: data.id, slug: data.slug, name: data.name } })
  },
)

servicesRouter.patch(
  "/:id",
  authenticate,
  requireProvider,
  zValidator("param", serviceIdParamSchema),
  zValidator("json", patchServiceBodySchema),
  async (c) => {
    const { id } = c.req.valid("param")
    const user = c.var.user
    const body = c.req.valid("json")

    try {
      await assertServiceOwnerOrAdmin(user, id)
    } catch (e) {
      const { message, status } = serviceAccessErrorResponse(e)
      return c.json({ error: message }, status)
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.kind !== undefined) updates.kind = body.kind
    if (body.short_description !== undefined) updates.short_description = body.short_description
    if (body.description !== undefined) updates.description = body.description
    if (body.price_flat !== undefined) updates.price_flat = body.price_flat
    if (body.location !== undefined) updates.location = body.location
    if (body.image_url !== undefined) updates.image_url = body.image_url
    if (body.images !== undefined) updates.images = body.images
    if (body.sort_order !== undefined) updates.sort_order = body.sort_order
    if (body.slug !== undefined) updates.slug = body.slug.trim()

    let qb = supabase.from("provider_services").update(updates).eq("id", id)
    if (user.role !== "admin") qb = qb.eq("provider_id", user.id)

    const { data, error } = await qb.select(SERVICE_SELECT_DETAIL).maybeSingle()
    if (error) {
      if (error.code === "23505") return c.json({ error: "Slug already exists" }, 409)
      return c.json({ error: error.message }, 400)
    }
    if (!data) return c.json({ error: "Service not found or unauthorized" }, 404)
    return c.json({ data })
  },
)

/** Public detail by slug — published only. */
servicesRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug")

  const { data, error } = await supabase
    .from("provider_services")
    .select(SERVICE_SELECT_PUBLIC + ", description")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle()

  if (error) return c.json({ error: error.message }, 500)
  if (!data) return c.json({ error: "Service not found" }, 404)
  return c.json({ data })
})

export function buildServiceSnapshot(svc: Record<string, unknown>, quantity: number): Record<string, unknown> {
  return {
    service_name: svc.name,
    service_slug: svc.slug,
    kind: svc.kind,
    price_flat: svc.price_flat,
    quantity,
  }
}
