import { z } from 'zod';
import { supabase } from './supabase.js';

const emptyToUndef = (v: unknown) => (v === '' || v === null ? undefined : v);

export const serviceOptionInputSchema = z.object({
	id: z.string().uuid().optional(),
	label: z.string().trim().min(1),
	description: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
	price_adjustment: z.coerce.number().int().default(0),
	image_url: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
	sort_order: z.coerce.number().int().optional().default(0),
	is_active: z.boolean().optional().default(true),
});

export const serviceOptionGroupInputSchema = z.object({
	id: z.string().uuid().optional(),
	title: z.string().trim().min(1),
	description: z.preprocess(emptyToUndef, z.string().trim().max(2000).optional()),
	is_required: z.boolean().optional().default(true),
	max_choices: z.coerce.number().int().min(1).max(20).optional().default(1),
	sort_order: z.coerce.number().int().optional().default(0),
	options: z.array(serviceOptionInputSchema).min(1).max(50),
});

export type ServiceOptionGroupInput = z.infer<typeof serviceOptionGroupInputSchema>;

export const SERVICE_OPTION_SELECT =
	'id, group_id, label, description, price_adjustment, image_url, is_active, sort_order';

export const SERVICE_OPTION_GROUP_SELECT = `id, service_id, title, description, is_required, max_choices, sort_order, provider_service_options (${SERVICE_OPTION_SELECT})`;

export async function loadServiceOptionGroups(
	serviceId: string,
	activeOnly = false,
): Promise<Record<string, unknown>[]> {
	const { data, error } = await supabase
		.from('provider_service_option_groups')
		.select(SERVICE_OPTION_GROUP_SELECT)
		.eq('service_id', serviceId)
		.order('sort_order', { ascending: true });

	if (error) throw new Error(error.message);

	const groups = (data ?? []) as Record<string, unknown>[];
	return groups.map((g) => {
		const raw = g.provider_service_options as Record<string, unknown>[] | null;
		let options = Array.isArray(raw) ? [...raw] : [];
		options.sort((a, b) => Number(a.sort_order) - Number(b.sort_order));
		if (activeOnly) options = options.filter((o) => o.is_active !== false);
		const { provider_service_options: _drop, ...rest } = g;
		return { ...rest, options };
	});
}

export async function syncServiceOptionGroups(
	serviceId: string,
	groups: ServiceOptionGroupInput[],
): Promise<{ ok: true } | { ok: false; error: string; statusCode: 400 | 500 }> {
	if (groups.length > 20) {
		return { ok: false, error: 'Хамгийн ихдээ 20 сонголтын бүлэг байна', statusCode: 400 };
	}

	const { data: existing, error: listErr } = await supabase
		.from('provider_service_option_groups')
		.select('id')
		.eq('service_id', serviceId);

	if (listErr) return { ok: false, error: listErr.message, statusCode: 500 };

	const existingIds = new Set((existing ?? []).map((r) => String(r.id)));
	const keptIds = new Set<string>();
	const now = new Date().toISOString();

	for (const group of groups) {
		let groupId = group.id;

		if (groupId && existingIds.has(groupId)) {
			const { error: upErr } = await supabase
				.from('provider_service_option_groups')
				.update({
					title: group.title.trim(),
					description: group.description ?? null,
					is_required: group.is_required ?? true,
					max_choices: group.max_choices ?? 1,
					sort_order: group.sort_order ?? 0,
					updated_at: now,
				})
				.eq('id', groupId);

			if (upErr) return { ok: false, error: upErr.message, statusCode: 400 };
		} else {
			const { data: inserted, error: insErr } = await supabase
				.from('provider_service_option_groups')
				.insert({
					service_id: serviceId,
					title: group.title.trim(),
					description: group.description ?? null,
					is_required: group.is_required ?? true,
					max_choices: group.max_choices ?? 1,
					sort_order: group.sort_order ?? 0,
					updated_at: now,
				})
				.select('id')
				.single();

			if (insErr || !inserted) {
				return { ok: false, error: insErr?.message ?? 'Insert failed', statusCode: 400 };
			}
			groupId = String(inserted.id);
		}

		keptIds.add(groupId);

		const { error: delOptErr } = await supabase
			.from('provider_service_options')
			.delete()
			.eq('group_id', groupId);
		if (delOptErr) return { ok: false, error: delOptErr.message, statusCode: 400 };

		const optionRows = group.options.map((opt) => ({
			group_id: groupId,
			label: opt.label.trim(),
			description: opt.description ?? null,
			price_adjustment: opt.price_adjustment ?? 0,
			image_url: opt.image_url ?? null,
			is_active: opt.is_active ?? true,
			sort_order: opt.sort_order ?? 0,
			updated_at: now,
		}));

		const { error: optInsErr } = await supabase.from('provider_service_options').insert(optionRows);
		if (optInsErr) return { ok: false, error: optInsErr.message, statusCode: 400 };
	}

	const toDelete = [...existingIds].filter((id) => !keptIds.has(id));
	if (toDelete.length > 0) {
		const { error: delErr } = await supabase
			.from('provider_service_option_groups')
			.delete()
			.in('id', toDelete);
		if (delErr) return { ok: false, error: delErr.message, statusCode: 400 };
	}

	return { ok: true };
}

export type ResolvedServiceOption = {
	option_id: string;
	group_id: string;
	group_title: string;
	label: string;
	price_adjustment: number;
};

export async function resolveServiceOptionSelections(
	serviceId: string,
	selectedOptionIds: string[],
	opts?: { requireSelectionWhenGroupsExist?: boolean },
): Promise<
	| { ok: true; selections: ResolvedServiceOption[]; optionsPriceSum: number; hasOptionGroups: boolean }
	| { ok: false; error: string }
> {
	const groups = await loadServiceOptionGroups(serviceId, true);

	if (groups.length === 0) {
		if (selectedOptionIds.length > 0) {
			return { ok: false, error: 'Энэ үйлчилгээнд сонголт байхгүй' };
		}
		return { ok: true, selections: [], optionsPriceSum: 0, hasOptionGroups: false };
	}

	if (opts?.requireSelectionWhenGroupsExist && selectedOptionIds.length === 0) {
		return { ok: false, error: 'Сонголт хийнэ үү' };
	}

	const optionById = new Map<string, { group: Record<string, unknown>; option: Record<string, unknown> }>();
	for (const group of groups) {
		for (const opt of (group.options as Record<string, unknown>[]) ?? []) {
			optionById.set(String(opt.id), { group, option: opt });
		}
	}

	const byGroup = new Map<string, string[]>();
	for (const optionId of selectedOptionIds) {
		const hit = optionById.get(optionId);
		if (!hit) return { ok: false, error: 'Сонголт олдсонгүй эсвэл идэвхгүй байна' };
		const gid = String(hit.group.id);
		const list = byGroup.get(gid) ?? [];
		list.push(optionId);
		byGroup.set(gid, list);
	}

	for (const group of groups) {
		const gid = String(group.id);
		const picked = byGroup.get(gid) ?? [];
		const required = group.is_required !== false;
		const maxChoices = Number(group.max_choices) || 1;

		if (required && picked.length === 0) {
			return { ok: false, error: `"${group.title}" сонгоно уу` };
		}
		if (picked.length > maxChoices) {
			return {
				ok: false,
				error: `"${group.title}" - хамгийн ихдээ ${maxChoices} сонголт хийнэ үү`,
			};
		}
	}

	const selections: ResolvedServiceOption[] = [];
	let optionsPriceSum = 0;

	for (const optionId of selectedOptionIds) {
		const hit = optionById.get(optionId)!;
		const optionPrice = Number(hit.option.price_adjustment) || 0;
		optionsPriceSum += optionPrice;
		selections.push({
			option_id: optionId,
			group_id: String(hit.group.id),
			group_title: String(hit.group.title),
			label: String(hit.option.label),
			price_adjustment: optionPrice,
		});
	}

	return { ok: true, selections, optionsPriceSum, hasOptionGroups: true };
}

/** When option groups exist and options are selected, price is options only — not base + options. */
export function computeServiceUnitPrice(
	basePrice: number,
	optionsPriceSum: number,
	hasOptionGroups: boolean,
	hasSelections: boolean,
): number {
	if (hasOptionGroups && hasSelections) {
		return Math.max(0, optionsPriceSum);
	}
	return Math.max(0, Number(basePrice));
}

export async function attachOptionGroupsToService(
	service: Record<string, unknown>,
	activeOnly = false,
): Promise<Record<string, unknown>> {
	const serviceId = String(service.id);
	const option_groups = await loadServiceOptionGroups(serviceId, activeOnly);
	return { ...service, option_groups };
}
