/** Flat venue rental when no event package is selected. */
export function venueOnlyOrderPrice(priceFlat: number): number {
	return Math.max(0, Number(priceFlat) || 0);
}

/** Venue event package: per-guest rate × guest count. */
export function venuePackageOrderPrice(pricePerPerson: number, guestCount: number): number {
	const guests = Math.max(1, Math.floor(Number(guestCount) || 1));
	return Math.max(0, Number(pricePerPerson) || 0) * guests;
}
