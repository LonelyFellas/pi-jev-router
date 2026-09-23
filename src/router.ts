import type {
	ThinkingLevel,
	AnyModel,
	JevTaskAnalysis,
	ModelLike,
	RouteCandidate,
	RouteDecision,
	RouterConfig,
} from "./types.ts";

// undefined means "no thinking level change" (off).
const THINKING_BY_COMPLEXITY: Record<number, ThinkingLevel | undefined> = {
	1: undefined,
	2: "low",
	3: "medium",
	4: "high",
	5: "xhigh",
};

function modelRef(model: ModelLike): string {
	return `${model.provider}/${model.id}`;
}

function resolveModel(ref: string, models: AnyModel[]): AnyModel | undefined {
	const [provider, ...rest] = ref.split("/");
	const id = rest.join("/");
	return models.find((m) => m.provider === provider && m.id === id);
}

/**
 * Effective thinking level for a candidate given task complexity.
 * Pinned candidate level wins; otherwise derive from complexity.
 * Returns undefined for non-reasoning models.
 */
function thinkingLevelFor(
	candidate: RouteCandidate,
	model: AnyModel,
	analysis: JevTaskAnalysis,
): ThinkingLevel | undefined {
	if (!model.reasoning) return undefined;
	return candidate.thinkingLevel ?? THINKING_BY_COMPLEXITY[analysis.complexity];
}

/** Effective capability tier: base strength boosted by thinking level. */
function capabilityOf(model: AnyModel, level: ThinkingLevel | undefined, base: number): number {
	if (!model.reasoning || !level) return base;
	const boost: Record<string, number> = {
		minimal: 0.2,
		low: 0.4,
		medium: 0.8,
		high: 1.4,
		xhigh: 1.8,
		max: 2.2,
	};
	return base + (boost[level] ?? 0);
}

/** Required capability from task analysis: complexity drives it, risk raises the floor. */
function requiredCapability(analysis: JevTaskAnalysis): number {
	const base = analysis.complexity;
	const riskFloor = analysis.risk >= 4 ? analysis.risk - 1 : 0;
	return Math.max(base, riskFloor);
}

/**
 * Pick a candidate: cheapest one whose effective capability meets the requirement.
 * Hard capability constraints (vision) filter first.
 */
function pickCandidate(
	analysis: JevTaskAnalysis,
	candidates: RouteCandidate[],
	models: AnyModel[],
): { candidate: RouteCandidate; model: AnyModel; level?: ThinkingLevel } | undefined {
	const resolved = candidates
		.map((candidate) => {
			const model = resolveModel(candidate.modelRef, models);
			if (!model) return undefined;
			if (analysis.needsVision && !model.input.includes("image")) return undefined;
			if (candidate.taskTypes?.length && !candidate.taskTypes.includes(analysis.taskType)) {
				return undefined;
			}
			const level = thinkingLevelFor(candidate, model, analysis);
			return { candidate, model, level, capability: capabilityOf(model, level, candidate.strengthTier) };
		})
		.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

	if (resolved.length === 0) return undefined;

	const required = requiredCapability(analysis);
	const sufficient = resolved.filter((entry) => entry.capability >= required);
	const pool = sufficient.length > 0 ? sufficient : resolved;

	// Cheapest sufficient; if none sufficient, strongest available.
	pool.sort((a, b) =>
		sufficient.length > 0
			? a.candidate.costTier - b.candidate.costTier || b.capability - a.capability
			: b.capability - a.capability,
	);

	return pool[0];
}

export interface RouteInput {
	taskText: string;
	hasImages: boolean;
	analysis?: JevTaskAnalysis;
	confidence?: number;
	config: RouterConfig;
	availableModels: AnyModel[];
	currentModel?: ModelLike;
}

/**
 * Decide which model to use. Pure function of its inputs, no I/O.
 * Never returns a model that isn't in availableModels.
 */
export function decideRoute(input: RouteInput): RouteDecision {
	const { analysis, config, availableModels, currentModel } = input;

	if (!analysis) {
		return fallbackDecision(config, availableModels, currentModel, "Jev 不可用，使用当前模型");
	}

	const picked = pickCandidate(analysis, config.candidates, availableModels);
	if (!picked) {
		return fallbackDecision(config, availableModels, currentModel, "没有匹配的候选模型，使用当前模型");
	}

	const reasonParts = [
		`任务类型 ${analysis.taskType}`,
		`复杂度 ${analysis.complexity}/5`,
		`风险 ${analysis.risk}/5`,
	];

	return {
		modelRef: modelRef(picked.model),
		thinkingLevel: picked.level,
		label: picked.candidate.label,
		reason: reasonParts.join(" · "),
		fromJev: true,
		analysis,
	};
}

function fallbackDecision(
	config: RouterConfig,
	availableModels: AnyModel[],
	currentModel: ModelLike | undefined,
	reason: string,
): RouteDecision {
	if (config.fallbackModelRef) {
		const model = resolveModel(config.fallbackModelRef, availableModels);
		if (model) {
			return {
				modelRef: config.fallbackModelRef,
				label: "Fallback",
				reason,
				fromJev: false,
			};
		}
	}

	const current = currentModel
		? availableModels.find((m) => m.provider === currentModel.provider && m.id === currentModel.id)
		: undefined;

	return {
		modelRef: current ? modelRef(current) : "",
		label: "Current",
		reason,
		fromJev: false,
	};
}
