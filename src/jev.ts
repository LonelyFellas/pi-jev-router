import { resolveCredential } from "./credentials.ts";
import type { JevFailureCategory, JevTaskAnalysis, RouteFailure, RouterConfig, TaskType } from "./types.ts";

interface JevAnswerChoice {
	type: "choice";
	choice: string;
	confidence: number;
	probabilities: Record<string, number>;
}

interface JevAnswerScore {
	type: "score";
	score: number;
	confidence: number;
	legend: Record<string, unknown>;
	probabilities: Record<string, number>;
}

interface JevAnswerNoul {
	type: "noul";
	noul: number;
}

type JevAnswer = JevAnswerChoice | JevAnswerScore | JevAnswerNoul;

interface JevResponse {
	model: string;
	answers: Record<string, JevAnswer>;
	usage: { input_tokens: number; output_tokens: number };
}

export interface JevAnalysisResult {
	analysis: JevTaskAnalysis;
	confidence: number;
	usage?: { inputTokens: number; outputTokens: number };
}

/** A redacted, categorized analyzer failure: no credentials or raw bodies escape. */
export class JevAnalysisError extends Error {
	readonly category: JevFailureCategory;
	readonly status?: number;

	constructor(category: JevFailureCategory, message: string, options: { status?: number; cause?: unknown } = {}) {
		super(message, { cause: options.cause });
		this.name = "JevAnalysisError";
		this.category = category;
		this.status = options.status;
	}
}

/** Shortest description that still identifies the failure in `/route status`. */
export function describeFailure(error: unknown, elapsedMs: number): RouteFailure {
	const failure =
		error instanceof JevAnalysisError
			? error
			: new JevAnalysisError("network", error instanceof Error ? error.message : String(error));
	return {
		category: failure.category,
		message: failure.message.slice(0, 200),
		elapsedMs,
		...(failure.status !== undefined && { status: failure.status }),
	};
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const TASK_TYPES: TaskType[] = ["qa", "docs", "refactor", "bugfix", "debug", "review", "build"];

function buildState(taskText: string, hasImages: boolean): Record<string, unknown> {
	return {
		task: taskText,
		has_image_attachments: hasImages,
	};
}

function buildQuestions() {
	return {
		task_type: {
			type: "choice",
			instructions:
				"What kind of task is `task`? Choose the best fit. " +
				"qa: answering a question or explanation; docs: writing or editing documentation/copy; " +
				"refactor: restructuring existing code without new behavior; bugfix: fixing a specific known defect; " +
				"debug: investigating an unknown failure or error; review: reviewing code or a diff; " +
				"build: implementing a new feature or change.",
			criteria: {
				qa: "Answering a question, explanation, or simple how-to",
				docs: "Writing or editing documentation or copy",
				refactor: "Restructuring code without changing behavior",
				bugfix: "Fixing a specific, described defect",
				debug: "Investigating an unclear failure, error, or behavior",
				review: "Reviewing code, diffs, or PRs",
				build: "Implementing a new feature or non-trivial change",
			},
		},
		complexity: {
			type: "score",
			instructions:
				"How much reasoning and code understanding will `task` likely require? " +
				"Consider scope (single file vs multi-module), ambiguity, and debugging depth.",
			criteria: [
				"Trivial: a short answer or one-line change",
				"Simple: single file or function, clear requirements",
				"Moderate: several files or some investigation",
				"Complex: multi-module work or non-trivial debugging",
				"Very complex: cross-repo, deep architecture, or hard debugging",
			],
		},
		risk: {
			type: "score",
			instructions:
				"How costly would a wrong or sloppy result for `task` be? " +
				"Consider production impact, data loss, security, and irreversibility.",
			criteria: [
				"Negligible: casual or easily reversible",
				"Low: minor inconvenience if wrong",
				"Moderate: noticeable rework if wrong",
				"High: could break important behavior",
				"Critical: security, data loss, or production outage risk",
			],
		},
		sufficient: {
			type: "noul",
			instructions:
				"Is `task` described well enough to choose an execution model without asking the user anything? " +
				"Answer yes unless the request is essentially empty or incomprehensible.",
			criteria: {
				true: "The request has enough substance to judge task type and difficulty",
				false: "The request is too vague or empty to judge",
			},
		},
	};
}

export async function analyzeTask(
	taskText: string,
	hasImages: boolean,
	config: RouterConfig,
	signal?: AbortSignal,
): Promise<JevAnalysisResult> {
	// A signal that is already aborted means the caller no longer wants the result: fail
	// before spending a request. Adding an "abort" listener later would never fire.
	signal?.throwIfAborted();

	let apiKey: string | null;
	try {
		apiKey = await resolveCredential({
			provider: "Jev",
			configuredValue: config.jev.apiKey,
			environmentValue: process.env[config.jev.apiKeyEnv],
			signal,
		});
	} catch (error) {
		// CredentialResolutionError already carries a category in its message; nothing here
		// contains the credential itself.
		throw new JevAnalysisError("credential", errorMessage(error), { cause: error });
	}
	if (!apiKey) {
		throw new JevAnalysisError(
			"missing-key",
			`Missing env var ${config.jev.apiKeyEnv} (TypeSafe API key)`,
		);
	}

	// Credential resolution can await a command source, so the signal may have aborted
	// while we waited; keep cancellation connected through to the request.
	signal?.throwIfAborted();

	const controller = new AbortController();
	const timedOut = new Error("Jev request timed out");
	const timer = setTimeout(() => controller.abort(timedOut), config.jev.timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort);

	try {
		let response: Response;
		try {
			response = await fetch(`${config.jev.baseUrl}/v1/systemone`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: "jev-latest",
					state: buildState(taskText, hasImages),
					questions: buildQuestions(),
				}),
				signal: controller.signal,
			});
		} catch (error) {
			throw requestFailure(error, signal, controller.signal, timedOut);
		}

		if (!response.ok) {
			const status = response.status;
			// The response body is discarded on purpose: it can echo, truncate or mask parts of
			// the credential, and this message is persisted in the session and shown in
			// `/route status`. Status plus category is what stays diagnosable.
			throw new JevAnalysisError(
				status >= 500 ? "http-server" : "http-client",
				`Jev API error ${status}`,
				{ status },
			);
		}

		let data: JevResponse;
		try {
			data = (await response.json()) as JevResponse;
		} catch (error) {
			throw new JevAnalysisError("invalid-response", "Jev response was not valid JSON", { cause: error });
		}

		return parseAnalysis(data, hasImages);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Classify a fetch rejection: caller cancellation, our own timeout, or transport. */
function requestFailure(
	error: unknown,
	caller: AbortSignal | undefined,
	request: AbortSignal,
	timedOut: Error,
): JevAnalysisError {
	if (caller?.aborted) return new JevAnalysisError("aborted", "Jev request cancelled", { cause: error });
	if (request.aborted) return new JevAnalysisError("timeout", timedOut.message, { cause: error });
	return new JevAnalysisError("network", errorMessage(error), { cause: error });
}

function clampScore(value: number): 1 | 2 | 3 | 4 | 5 {
	const rounded = Math.min(5, Math.max(1, Math.round(value)));
	return rounded as 1 | 2 | 3 | 4 | 5;
}

function clampUnit(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/**
 * Validate the response before it can influence routing: a non-finite score used to
 * become NaN, which silently lost every capability comparison and picked the strongest
 * candidate. Failures are categorized so `/route status` can explain them.
 */
function parseAnalysis(data: JevResponse, hasImages: boolean): JevAnalysisResult {
	const answers = data?.answers;
	const taskTypeAnswer = answers?.task_type;
	const complexityAnswer = answers?.complexity;
	const riskAnswer = answers?.risk;
	const sufficientAnswer = answers?.sufficient;

	if (
		taskTypeAnswer?.type !== "choice" ||
		complexityAnswer?.type !== "score" ||
		riskAnswer?.type !== "score" ||
		sufficientAnswer?.type !== "noul"
	) {
		throw new JevAnalysisError("invalid-response", "Jev response missing expected answers");
	}
	if (typeof taskTypeAnswer.choice !== "string") {
		throw new JevAnalysisError("invalid-response", "Jev response contained a non-string task type");
	}

	const complexityScore = finiteNumber(complexityAnswer.score);
	const riskScore = finiteNumber(riskAnswer.score);
	const sufficiency = finiteNumber(sufficientAnswer.noul);
	const taskTypeConfidence = finiteNumber(taskTypeAnswer.confidence);
	const complexityConfidence = finiteNumber(complexityAnswer.confidence);
	if (
		complexityScore === undefined ||
		riskScore === undefined ||
		sufficiency === undefined ||
		taskTypeConfidence === undefined ||
		complexityConfidence === undefined
	) {
		throw new JevAnalysisError("invalid-response", "Jev response contained non-numeric scores or confidences");
	}

	const taskType = TASK_TYPES.includes(taskTypeAnswer.choice as TaskType)
		? (taskTypeAnswer.choice as TaskType)
		: "build";

	// Score levels are 0-indexed (0..4); map to 1..5.
	const analysis: JevTaskAnalysis = {
		taskType,
		complexity: clampScore(complexityScore + 1),
		risk: clampScore(riskScore + 1),
		needsVision: hasImages,
		sufficient: sufficiency >= 0.5,
	};

	// Usage is diagnostics only: a malformed count must not discard a usable analysis.
	const inputTokens = finiteNumber(data?.usage?.input_tokens);
	const outputTokens = finiteNumber(data?.usage?.output_tokens);
	return {
		analysis,
		confidence: clampUnit(Math.min(taskTypeConfidence, complexityConfidence)),
		...(inputTokens !== undefined &&
			outputTokens !== undefined && { usage: { inputTokens, outputTokens } }),
	};
}
