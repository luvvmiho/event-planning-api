import type { User } from "@supabase/supabase-js"
import { createMiddleware } from "hono/factory"
import { HTTPException } from "hono/http-exception"
import { supabase } from "../lib/supabase.js"
import type { AuthUser } from "../types/index.js"

export const mapSupabaseUserToAuthUser = (user: User): AuthUser => {
  const appRole = user.app_metadata?.role as string | undefined
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>
  const metaRole = meta.role as string | undefined
  const userType = meta.user_type as string | undefined

  let role: AuthUser["role"] = "authenticated"
  if (appRole === "admin" || metaRole === "admin") role = "admin"
  else if (appRole === "provider" || metaRole === "provider" || userType === "provider") role = "provider"
  else if (appRole === "customer" || metaRole === "customer" || userType === "user") role = "customer"

  return {
    id: user.id,
    email: user.email,
    role,
    userType,
  }
}

export const loadAuthUserFromToken = async (accessToken: string): Promise<AuthUser | null> => {
  const { data, error } = await supabase.auth.getUser(accessToken)
  if (error || !data.user) return null
  return mapSupabaseUserToAuthUser(data.user)
}

export const authenticate = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization")

  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Missing or invalid Authorization header" })
  }

  const token = authHeader.slice(7)
  const user = await loadAuthUserFromToken(token)

  if (!user) {
    throw new HTTPException(401, { message: "Invalid or expired token" })
  }

  c.set("user", user)
  await next()
})

export const requireAdmin = createMiddleware(async (c, next) => {
  const user = c.var.user

  if (!user || user.role !== "admin") {
    throw new HTTPException(403, { message: "Admin access required" })
  }

  await next()
})

export const userIsEligibleProvider = async (user: AuthUser): Promise<boolean> => {
  if (user.role === "admin" || user.role === "provider") return true
  if (user.userType === "provider") return true

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profileErr && profile?.user_type === "provider") return true

  return false
}

export const assertProviderAccess = async (user: AuthUser): Promise<void> => {
  const ok = await userIsEligibleProvider(user)
  if (!ok) {
    throw new HTTPException(403, { message: "Provider access required" })
  }
}

export const requireProvider = createMiddleware(async (c, next) => {
  await assertProviderAccess(c.var.user)
  await next()
})

export const assertScopedProviderVenueAccess = async (
  authHeader: string | undefined,
  providerId: string
): Promise<AuthUser> => {
  if (!authHeader?.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Нэвтрэх шаардлагатай" })
  }

  const token = authHeader.slice(7)
  const user = await loadAuthUserFromToken(token)
  if (!user) {
    throw new HTTPException(401, { message: "Хүчингүй эсвэл хугацаа дууссан токен" })
  }

  await assertProviderAccess(user)

  if (user.role !== "admin" && user.id !== providerId) {
    throw new HTTPException(403, { message: "Зөвхөн өөрийн байршлыг харна уу" })
  }

  return user
}
