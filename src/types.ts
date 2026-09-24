import type { Model } from "@earendil-works/pi-ai";

/**
 * Thinking levels pi accepts at runtime. This mirrors the `ThinkingLevel` the extension API
 * actually uses (`pi-agent-core`, which includes `"off"`). pi-ai exports a narrower type of
 * the same name; using that one dropped a legitimate `thinkingLevel: "off"` pin.
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type RouteMode = "auto" | "locked" | "shadow";

export type TaskType =
	| "qa"
	| "docs"
	| "refactor"
	| "bugfix"
	| "debug"
	| "review"
	| "build";

export interface RouteCandidate {
	/** Reference to a model, e.g. "anthropic/claude-sonnet-4-5" */
	modelRef: string;
	/** Default thinking level for this candidate, if the model supports reasoning */
	thinkingLevel?: ThinkingLevel;
	/** Short label shown to the user, e.g. "Strong reasoning" */
	label: string;
	/** Task types this candidate fits. Empty = all. */
	taskTypes?: TaskType[];
	/** Higher = cheaper/faster preferred. Lower = stronger preferred. */
	costTier: number; // 1 (cheap) .. 5 (expensive)
	strengthTier: number; // 1 (weak) .. 5 (strong)
}

export interface RouterConfig {
	mode: RouteMode;
	candidates: RouteCandidate[];
	/** Fallback model reference used when Jev is unavailable or undecided. */
	fallbackModelRef?: string;
	/**
	 * What to do when the analyzer calls the first task under-specified
	 * (`analysis.sufficient === false`). `advisory` (default) keeps the current model and only
	 * shows the recommendation; `route` applies it anyway.
	 */
	insufficientPolicy?: "advisory" | "route";
	/** Treat an analysis below this confidence as advisory too. 0 (default) disables it. */
	minConfidence?: number;
	/** Jev API settings. Credentials resolve per request; values are never logged. */
	jev: {
		baseUrl: string; // e.g. https://api.typesafe.ai
		/** Credential source: "$ENV", "${ENV}", "!command", or a literal (not recommended). */
		apiKey?: string;
		/** Legacy fallback env var name used when apiKey is not configured. */
		apiKeyEnv: string;
		timeoutMs: number;
	};
}

export interface JevTaskAnalysis {
	taskType: TaskType;
	complexity: 1 | 2 | 3 | 4 | 5;
	risk: 1 | 2 | 3 | 4 | 5;
	needsVision: boolean;
	sufficient: boolean; // description sufficient to route
}

/**
 * Why a Jev analysis produced no decision. Kept as a short category so failures stay
 * observable without logging request bodies or credentials.
 */
export type JevFailureCategory =
	| "missing-key"
	| "credential"
	| "timeout"
	| "http-client"
	| "http-server"
	| "invalid-response"
	| "network"
	| "aborted";

export interface RouteFailure {
	category: JevFailureCategory;
	/** Redacted, already-truncated description for `/route status`. */
	message: string;
	elapsedMs: number;
	/** HTTP status when the failure came from a response. */
	status?: number;
}

export interface RouteDecision {
	modelRef: string;
	thinkingLevel?: ThinkingLevel;
	label: string;
	reason: string;
	fromJev: boolean;
	analysis?: JevTaskAnalysis;
	/** Analyzer confidence, recorded for calibration. Not used to gate routing yet. */
	confidence?: number;
	/**
	 * Level that ended up in effect. pi clamps the requested level to what the model
	 * supports, so this can differ from `thinkingLevel` (e.g. xhigh → high).
	 */
	effectiveThinkingLevel?: ThinkingLevel;
	/**
	 * The decision was left advisory: the analysis was not trustworthy enough to act on, so the
	 * current model and level were kept and this is only a suggestion.
	 */
	advisory?: boolean;
	/** Why it was left advisory, so status and notifications can say which gate fired. */
	advisoryReason?: "insufficient" | "low-confidence";
	/** Present when the analyzer failed and the decision fell back. */
	failure?: RouteFailure;
}

export interface ModelLike {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	input: ("text" | "image")[];
	contextWindow: number;
}

export type AnyModel = Model<any>;
