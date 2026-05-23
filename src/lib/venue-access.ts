import { supabase } from "./supabase.js"
import type { AuthUser } from "../types/index.js"

export const VENUE_STATUSES = ["draft", "published", "archived"] as const
export type VenueStatus = (typeof VENUE_STATUSES)[number]

/** Provider owns venue, or caller is admin. */
export async function assertVenueOwnerOrAdmin(
  user: AuthUser,
  venueId: string,
): Promise<{ provider_id: string }> {
  const { data, error } = await supabase
    .from("venues")
    .select("provider_id")
    .eq("id", venueId)
    .maybeSingle()

  if (error || !data?.provider_id) {
    throw new Error("VENUE_NOT_FOUND")
  }
  if (user.role !== "admin" && data.provider_id !== user.id) {
    throw new Error("VENUE_FORBIDDEN")
  }
  return { provider_id: data.provider_id }
}

export function venueAccessErrorResponse(err: unknown): { message: string; status: 404 | 403 } {
  if (err instanceof Error && err.message === "VENUE_FORBIDDEN") {
    return { message: "Venue not found or unauthorized", status: 403 }
  }
  return { message: "Venue not found", status: 404 }
}
