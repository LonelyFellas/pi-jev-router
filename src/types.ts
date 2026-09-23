import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

export type { ThinkingLevel };

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
	/** Jev API settings. apiKey read from env var name. */
	jev: {
		baseUrl: string; // e.g. https://api.typesafe.ai
		apiKeyEnv: string; // env var name holding the key
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

export interface RouteDecision {
	modelRef: string;
	thinkingLevel?: ThinkingLevel;
	label: string;
	reason: string;
	fromJev: boolean;
	analysis?: JevTaskAnalysis;
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
