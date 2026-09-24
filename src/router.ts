import type {
	ThinkingLevel,
	AnyModel,
	JevTaskAnalysis,
	ModelLike,
	RouteCandidate,
	RouteDecision,
	RouteFailure,
	RouteMode,
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

/**
 * Whether any configured candidate could possibly be picked, using only information
 * available before the analysis: it must resolve to an available model, and must accept
 * images when the task has them. `taskTypes` needs the analyzer's task type, so this is
 * a necessary condition only — `false` means `pickCandidate` would return undefined for
 * every possible analysis, which makes a Jev request pointless.
 */
export function hasRouteableCandidate(
	config: RouterConfig,
	availableModels: AnyModel[],
	hasImages: boolean,
): boolean {
	return config.candidates.some((candidate) => {
		const model = resolveModel(candidate.modelRef, availableModels);
		if (!model) return false;
		if (hasImages && !model.input.includes("image")) return false;
		return true;
	});
}

export interface RouteInput {
	taskText: string;
	hasImages: boolean;
	analysis?: JevTaskAnalysis;
	confidence?: number;
	config: RouterConfig;
	availableModels: AnyModel[];
	currentModel?: ModelLike;
	/** Reason recorded when no analysis is available (e.g. the analyzer was skipped). */
	noAnalysisReason?: string;
	/** Analyzer failure to keep visible on the decision, when there was one. */
	failure?: RouteFailure;
}

/**
 * Decide which model to use. Pure function of its inputs, no I/O.
 * Never returns a model that isn't in availableModels.
 */
export function decideRoute(input: RouteInput): RouteDecision {
	const { analysis, config, availableModels, currentModel } = input;

	if (!analysis) {
		return fallbackDecision(
			config,
			availableModels,
			currentModel,
			input.noAnalysisReason ?? "Jev 不可用，使用当前模型",
			input.failure,
		);
	}

	const picked = pickCandidate(analysis, config.candidates, availableModels);
	if (!picked) {
		return fallbackDecision(
			config,
			availableModels,
			currentModel,
			"没有匹配的候选模型，使用当前模型",
			input.failure,
		);
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
		// Recorded for calibration only: no routing decision depends on it yet.
		confidence: input.confidence,
	};
}

export interface RouteApplicationPlan {
	/** Switch the active model to the decision's model. */
	switchModel: boolean;
	/** Apply the decision's thinking level to whatever model ends up active. */
	applyThinkingLevel: boolean;
	/**
	 * True when the analysis was not trustworthy enough to act on. The recommendation stays
	 * advisory: status and notifications show it, the current model and level are left alone.
	 */
	advisory: boolean;
	/** Which gate made it advisory, for accurate messaging. */
	advisoryReason?: "insufficient" | "low-confidence";
}

/**
 * How much trust an analysis needs before the router acts on it. `minConfidence` 0 disables
 * the confidence gate; `insufficientPolicy` "advisory" (the default) refuses to act on a task
 * the analyzer called under-specified.
 */
export interface RoutePolicy {
	insufficientPolicy: "advisory" | "route";
	minConfidence: number;
}

export const DEFAULT_ROUTE_POLICY: RoutePolicy = { insufficientPolicy: "advisory", minConfidence: 0 };

/**
 * Decide what a routing decision should actually do. Kept separate from the
 * model switch so a recommendation for the already-active model still applies
 * its thinking level. Shadow mode, user overrides and untrusted analyses never
 * apply anything.
 */
export function planRouteApplication(
	decision: RouteDecision,
	mode: RouteMode,
	userOverrode: boolean,
	currentModelRef: string | undefined,
	policy: RoutePolicy = DEFAULT_ROUTE_POLICY,
): RouteApplicationPlan {
	if (mode !== "auto" || userOverrode) {
		return { switchModel: false, applyThinkingLevel: false, advisory: false };
	}
	// Acting on a description the analyzer called insufficient, or on a low-confidence
	// analysis, is a guess: switching would cost a model change (and a cache miss) for a
	// recommendation we cannot trust.
	if (policy.insufficientPolicy === "advisory" && decision.analysis?.sufficient === false) {
		return { switchModel: false, applyThinkingLevel: false, advisory: true, advisoryReason: "insufficient" };
	}
	if (
		policy.minConfidence > 0 &&
		typeof decision.confidence === "number" &&
		decision.confidence < policy.minConfidence
	) {
		return { switchModel: false, applyThinkingLevel: false, advisory: true, advisoryReason: "low-confidence" };
	}
	const alreadyActive = !!currentModelRef && currentModelRef === decision.modelRef;
	return {
		switchModel: !alreadyActive,
		applyThinkingLevel: decision.thinkingLevel !== undefined,
		advisory: false,
	};
}

function fallbackDecision(
	config: RouterConfig,
	availableModels: AnyModel[],
	currentModel: ModelLike | undefined,
	reason: string,
	failure?: RouteFailure,
): RouteDecision {
	if (config.fallbackModelRef) {
		const model = resolveModel(config.fallbackModelRef, availableModels);
		if (model) {
			return {
				modelRef: config.fallbackModelRef,
				label: "Fallback",
				reason,
				fromJev: false,
				...(failure && { failure }),
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
		...(failure && { failure }),
	};
}
