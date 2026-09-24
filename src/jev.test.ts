/**
 * Cancellation, failure-category and response-validation tests for analyzeTask
 * (stubbed fetch, no network).
 * Run: npx tsx src/jev.test.ts
 */
import assert from "node:assert/strict";
import { analyzeTask, describeFailure, JevAnalysisError } from "./jev.ts";
import type { RouterConfig } from "./types.ts";

const NO_KEY_ENV = "PI_JSV_ROUTER_TEST_MISSING_KEY";
delete process.env[NO_KEY_ENV];

function config(overrides: Partial<RouterConfig["jev"]> = {}): RouterConfig {
	return {
		mode: "auto",
		candidates: [],
		jev: { baseUrl: "https://jev.invalid", apiKeyEnv: NO_KEY_ENV, timeoutMs: 1_000, apiKey: "literal-key", ...overrides },
	};
}

interface Answers {
	task_type?: unknown;
	complexity?: unknown;
	risk?: unknown;
	sufficient?: unknown;
}

function payload(answers: Answers = {}, usage: unknown = { input_tokens: 1, output_tokens: 2 }): string {
	return JSON.stringify({
		model: "jev-latest",
		answers: {
			task_type: { type: "choice", choice: "qa", confidence: 0.9, probabilities: {} },
			complexity: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} },
			risk: { type: "score", score: 0, confidence: 0.9, legend: {}, probabilities: {} },
			sufficient: { type: "noul", noul: 1 },
			...answers,
		},
		usage,
	});
}

function jsonResponse(body: string, status = 200): Response {
	return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const realFetch = globalThis.fetch;
let fetchCalls = 0;
let lastRequestSignal: AbortSignal | null | undefined;

async function expectCategory(promise: Promise<unknown>, category: string): Promise<JevAnalysisError> {
	let caught: unknown;
	await promise.catch((error: unknown) => {
		caught = error;
	});
	assert.ok(caught instanceof JevAnalysisError, `expected a JevAnalysisError, got ${String(caught)}`);
	assert.equal(caught.category, category);
	return caught;
}

try {
	globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
		fetchCalls += 1;
		lastRequestSignal = init?.signal;
		const signal = init?.signal;
		if (signal?.aborted) throw signal.reason;
		return jsonResponse(payload());
	}) as typeof fetch;

	// 1. A signal that is already aborted must fail before any request goes out.
	{
		const controller = new AbortController();
		controller.abort();
		fetchCalls = 0;
		await assert.rejects(
			analyzeTask("first task", false, config(), controller.signal),
			"an already-aborted signal must reject",
		);
		assert.equal(fetchCalls, 0, "no Jev request may be sent for an aborted signal");
	}

	// 2. An abort that lands while credentials resolve must still cancel the request —
	//    the "abort" listener is added after that await and would miss it.
	{
		const controller = new AbortController();
		fetchCalls = 0;
		const jevConfig = config();
		Object.defineProperty(jevConfig.jev, "apiKeyEnv", {
			get() {
				controller.abort(new Error("cancelled during credential resolution"));
				return NO_KEY_ENV;
			},
		});
		await assert.rejects(analyzeTask("first task", false, jevConfig, controller.signal));
		assert.equal(fetchCalls, 0, "an abort during credential resolution must cancel the request");
	}

	// 3. An abort while the request is in flight must abort the request signal itself.
	{
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			fetchCalls += 1;
			lastRequestSignal = init?.signal;
			const signal = init?.signal;
			return await new Promise<Response>((_resolve, reject) => {
				if (!signal) throw new Error("expected a request signal");
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}) as typeof fetch;

		const controller = new AbortController();
		fetchCalls = 0;
		const pending = analyzeTask("first task", false, config(), controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(fetchCalls, 1, "the request must have started before the abort");
		controller.abort(new Error("cancelled mid-request"));
		const error = await expectCategory(pending, "aborted");
		assert.equal(error.message, "Jev request cancelled");
		assert.equal(lastRequestSignal?.aborted, true, "the in-flight request signal must be aborted");
	}

	// 4. Failures are categorized, HTTP statuses are kept, and no response body is retained
	//    (it can echo a truncated or masked credential and is persisted in the session).
	{
		globalThis.fetch = (async () => jsonResponse('{"error":"bad key sk-live-abc123"}', 401)) as typeof fetch;
		const unauthorized = await expectCategory(analyzeTask("t", false, config()), "http-client");
		assert.equal(unauthorized.status, 401);
		assert.equal(unauthorized.message, "Jev API error 401");
		assert.doesNotMatch(unauthorized.message, /sk-live/, "the body must not reach the persisted message");

		globalThis.fetch = (async () => jsonResponse("boom", 503)) as typeof fetch;
		const unavailable = await expectCategory(analyzeTask("t", false, config()), "http-server");
		assert.equal(unavailable.status, 503);

		globalThis.fetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		await expectCategory(analyzeTask("t", false, config()), "network");

		globalThis.fetch = (async () => jsonResponse("not json")) as typeof fetch;
		await expectCategory(analyzeTask("t", false, config()), "invalid-response");

		const controller = new AbortController();
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			const signal = init?.signal;
			return await new Promise<Response>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		}) as typeof fetch;
		const timedOut = await expectCategory(analyzeTask("t", false, config({ timeoutMs: 5 }), controller.signal), "timeout");
		assert.match(timedOut.message, /timed out/);
	}

	// 5. Non-numeric or missing numbers must not become NaN in the analysis.
	{
		for (const answers of [
			{ complexity: { type: "score", score: Number.NaN, confidence: 0.9 } },
			{ complexity: { type: "score", score: 0, confidence: "high" } },
			{ risk: { type: "score", score: null, confidence: 0.9 } },
			{ sufficient: { type: "noul", noul: "yes" } },
			{ task_type: { type: "choice", choice: 7, confidence: 0.9 } },
		] as Answers[]) {
			globalThis.fetch = (async () => jsonResponse(payload(answers))) as typeof fetch;
			await expectCategory(analyzeTask("t", false, config()), "invalid-response");
		}

		globalThis.fetch = (async () =>
			jsonResponse(JSON.stringify({ answers: { task_type: { type: "choice", choice: "qa" } } }))) as typeof fetch;
		await expectCategory(analyzeTask("t", false, config()), "invalid-response");
	}

	// 6. Valid numbers are still clamped into range; bad usage degrades, it does not fail.
	{
		globalThis.fetch = (async () =>
			jsonResponse(
				payload(
					{
						task_type: { type: "choice", choice: "debug", confidence: 1.4 },
						complexity: { type: "score", score: 9, confidence: 1.2 },
						risk: { type: "score", score: -3, confidence: 0.8 },
					},
					{ input_tokens: "many" },
				),
			)) as typeof fetch;
		const result = await analyzeTask("t", true, config());
		assert.equal(result.analysis.taskType, "debug");
		assert.equal(result.analysis.complexity, 5, "an out-of-range score is clamped, not propagated");
		assert.equal(result.analysis.risk, 1);
		assert.equal(result.analysis.needsVision, true);
		assert.equal(result.confidence, 1, "confidence is clamped into 0..1");
		assert.equal(result.usage, undefined, "a malformed usage count must not discard the analysis");
	}

	// 7. describeFailure normalizes anything thrown into a redacted, timed summary.
	{
		const described = describeFailure(new JevAnalysisError("timeout", "Jev request timed out"), 5001);
		assert.deepEqual(described, { category: "timeout", message: "Jev request timed out", elapsedMs: 5001 });

		const unknown = describeFailure(new Error("x".repeat(500)), 12);
		assert.equal(unknown.category, "network");
		assert.equal(unknown.message.length, 200);
	}

	console.log("jev.test: all assertions passed");
} finally {
	globalThis.fetch = realFetch;
}
