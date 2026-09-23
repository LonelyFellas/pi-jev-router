import type { JevTaskAnalysis, RouterConfig, TaskType } from "./types.ts";

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
	const apiKey = process.env[config.jev.apiKeyEnv];
	if (!apiKey) {
		throw new Error(`Missing env var ${config.jev.apiKeyEnv} (TypeSafe API key)`);
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Jev request timed out")), config.jev.timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	signal?.addEventListener("abort", onAbort);

	try {
		const response = await fetch(`${config.jev.baseUrl}/v1/systemone`, {
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

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Jev API error ${response.status}: ${body.slice(0, 200)}`);
		}

		const data = (await response.json()) as JevResponse;
		const answers = data.answers;

		const taskTypeAnswer = answers.task_type;
		const complexityAnswer = answers.complexity;
		const riskAnswer = answers.risk;
		const sufficientAnswer = answers.sufficient;

		if (
			taskTypeAnswer?.type !== "choice" ||
			complexityAnswer?.type !== "score" ||
			riskAnswer?.type !== "score" ||
			sufficientAnswer?.type !== "noul"
		) {
			throw new Error("Jev response missing expected answers");
		}

		const taskType = TASK_TYPES.includes(taskTypeAnswer.choice as TaskType)
			? (taskTypeAnswer.choice as TaskType)
			: "build";

		const clamp = (n: number): 1 | 2 | 3 | 4 | 5 => {
			const rounded = Math.min(5, Math.max(1, Math.round(n)));
			return rounded as 1 | 2 | 3 | 4 | 5;
		};

		// Score levels are 0-indexed (0..4); map to 1..5.
		const analysis: JevTaskAnalysis = {
			taskType,
			complexity: clamp(complexityAnswer.score + 1),
			risk: clamp(riskAnswer.score + 1),
			needsVision: hasImages,
			sufficient: sufficientAnswer.noul >= 0.5,
		};

		const confidence = Math.min(taskTypeAnswer.confidence, complexityAnswer.confidence);

		return {
			analysis,
			confidence,
			usage: {
				inputTokens: data.usage.input_tokens,
				outputTokens: data.usage.output_tokens,
			},
		};
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
