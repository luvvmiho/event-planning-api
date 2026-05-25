import { supabase } from "./supabase.js"
import type { AuthUser } from "../types/index.js"

export const SERVICE_KINDS = [
  "car",
  "cake",
  "photoshoot",
  "entertainment",
  "decoration",
  "catering",
  "other",
] as const

export type ServiceKind = (typeof SERVICE_KINDS)[number]

export const SERVICE_STATUSES = ["enabled", "disabled"] as const
export type ServiceStatus = (typeof SERVICE_STATUSES)[number]

export async function assertServiceOwnerOrAdmin(
  user: AuthUser,
  serviceId: string,
): Promise<{ provider_id: string }> {
  const { data, error } = await supabase
    .from("provider_services")
    .select("provider_id")
    .eq("id", serviceId)
    .maybeSingle()

  if (error || !data?.provider_id) throw new Error("SERVICE_NOT_FOUND")
  if (user.role !== "admin" && data.provider_id !== user.id) throw new Error("SERVICE_FORBIDDEN")
  return { provider_id: data.provider_id }
}

export function serviceAccessErrorResponse(err: unknown): { message: string; status: 404 | 403 } {
  if (err instanceof Error && err.message === "SERVICE_FORBIDDEN") {
    return { message: "Service not found or unauthorized", status: 403 }
  }
  return { message: "Service not found", status: 404 }
}
