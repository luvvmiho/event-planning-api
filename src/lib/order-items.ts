export type OrderItemJson = {
  itemType?: "venue" | "service"
  venueId?: string
  serviceId?: string
  name?: string
  providerLabel?: string
  category?: string
  categoryLabel?: string
  price?: number
  quantity?: number
  guestCount?: number
}

export const parseOrderItems = (items: unknown): OrderItemJson[] =>
  (Array.isArray(items) ? items : []) as OrderItemJson[]

export const isServiceOrderItem = (item: OrderItemJson): boolean =>
  item.itemType === "service" || (item.serviceId != null && item.serviceId.length > 0)
