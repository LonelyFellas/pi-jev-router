/**
 * Minimal smoke test for decideRoute (pure logic, no Jev/network).
 * Run: npx tsx src/router.test.ts
 */
import assert from "node:assert/strict";
import { decideRoute } from "./router.ts";
import type { AnyModel, JevTaskAnalysis, RouterConfig } from "./types.ts";

function fakeModel(ref: string, opts: Partial<AnyModel> = {}): AnyModel {
	const [provider, id] = ref.split("/");
	return {
		provider,
		id,
		name: id,
		reasoning: true,
		input: ["text"],
		contextWindow: 200_000,
		...opts,
	} as AnyModel;
}

const models = [
	fakeModel("test/cheap", { reasoning: false }),
	fakeModel("test/mid"),
	fakeModel("test/strong"),
	fakeModel("test/vision", { input: ["text", "image"] }),
];

const config: RouterConfig = {
	mode: "auto",
	candidates: [
		{ modelRef: "test/cheap", label: "Cheap", costTier: 1, strengthTier: 1 },
		{ modelRef: "test/mid", label: "Mid", costTier: 3, strengthTier: 3 },
		{ modelRef: "test/strong", label: "Strong", costTier: 5, strengthTier: 5 },
		{ modelRef: "test/vision", label: "Vision", costTier: 4, strengthTier: 3, taskTypes: ["debug"] },
	],
	jev: { baseUrl: "", apiKeyEnv: "X", timeoutMs: 1000 },
};

function analysis(overrides: Partial<JevTaskAnalysis> = {}): JevTaskAnalysis {
	return { taskType: "qa", complexity: 1, risk: 1, needsVision: false, sufficient: true, ...overrides };
}

// 1. Trivial task → cheapest candidate.
{
	const d = decideRoute({ taskText: "hi", hasImages: false, analysis: analysis(), config, availableModels: models });
	assert.equal(d.modelRef, "test/cheap");
	assert.equal(d.fromJev, true);
}

// 2. Complex task → skips cheap, picks mid (3 + thinking boost ≥ 5? no: 3+1.8=4.8 < 5 → strong).
{
	const d = decideRoute({
		taskText: "cross-repo refactor",
		hasImages: false,
		analysis: analysis({ taskType: "build", complexity: 5, risk: 3 }),
		config,
		availableModels: models,
	});
	assert.equal(d.modelRef, "test/strong");
}

// 3. Vision required → only image-capable models.
{
	const d = decideRoute({
		taskText: "look at this screenshot",
		hasImages: true,
		analysis: analysis({ taskType: "debug", complexity: 3, needsVision: true }),
		config,
		availableModels: models,
	});
	assert.equal(d.modelRef, "test/vision");
}

// 4. No analysis → falls back to current model.
{
	const d = decideRoute({
		taskText: "hi",
		hasImages: false,
		config,
		availableModels: models,
		currentModel: { provider: "test", id: "mid", name: "mid", reasoning: true, input: ["text"], contextWindow: 1 },
	});
	assert.equal(d.modelRef, "test/mid");
	assert.equal(d.fromJev, false);
}

// 5. Missing candidates → fallback, never an unknown model.
{
	const empty: RouterConfig = { ...config, candidates: [{ modelRef: "test/ghost", label: "G", costTier: 1, strengthTier: 1 }] };
	const d = decideRoute({
		taskText: "hi",
		hasImages: false,
		analysis: analysis(),
		config: empty,
		availableModels: models,
		currentModel: { provider: "test", id: "cheap", name: "cheap", reasoning: false, input: ["text"], contextWindow: 1 },
	});
	assert.equal(d.modelRef, "test/cheap");
	assert.equal(d.fromJev, false);
}

console.log("router.test: all assertions passed");
