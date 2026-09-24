/**
 * Minimal smoke test for decideRoute (pure logic, no Jev/network).
 * Run: npx tsx src/router.test.ts
 */
import assert from "node:assert/strict";
import { decideRoute, hasRouteableCandidate, planRouteApplication } from "./router.ts";
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

// 6. Application plan — a recommendation for the already-active model must still
//    apply its thinking level (switch and level are decided independently).
{
	const strong = { modelRef: "test/strong", thinkingLevel: "xhigh" as const, label: "S", reason: "r", fromJev: true };

	const sameModel = planRouteApplication(strong, "auto", false, "test/strong");
	assert.equal(sameModel.switchModel, false);
	assert.equal(sameModel.applyThinkingLevel, true, "thinking level must apply without a model switch");

	const otherModel = planRouteApplication(strong, "auto", false, "test/mid");
	assert.deepEqual(otherModel, { switchModel: true, applyThinkingLevel: true, advisory: false });

	const noCurrentModel = planRouteApplication(strong, "auto", false, undefined);
	assert.deepEqual(noCurrentModel, { switchModel: true, applyThinkingLevel: true, advisory: false });

	// Shadow mode and locked mode never apply anything.
	assert.deepEqual(planRouteApplication(strong, "shadow", false, "test/mid"), {
		switchModel: false,
		applyThinkingLevel: false,
		advisory: false,
	});
	assert.deepEqual(planRouteApplication(strong, "locked", false, "test/mid"), {
		switchModel: false,
		applyThinkingLevel: false,
		advisory: false,
	});

	// A user override wins over the recommendation.
	assert.deepEqual(planRouteApplication(strong, "auto", true, "test/mid"), {
		switchModel: false,
		applyThinkingLevel: false,
		advisory: false,
	});

	// No recommended level (e.g. non-reasoning model) → nothing to apply.
	const noLevel = { modelRef: "test/mid", label: "M", reason: "r", fromJev: false };
	assert.deepEqual(planRouteApplication(noLevel, "auto", false, "test/mid"), {
		switchModel: false,
		applyThinkingLevel: false,
		advisory: false,
	});
}

// 7. Local pre-filter: a Jev request may only be skipped when no candidate could ever be
//    picked, otherwise the saved request would change the outcome.
{
	assert.equal(hasRouteableCandidate(config, models, false), true);
	assert.equal(hasRouteableCandidate(config, models, true), true, "test/vision is image-capable");
	assert.equal(hasRouteableCandidate({ ...config, candidates: [] }, models, false), false);

	const missingModels: RouterConfig = {
		...config,
		candidates: [{ modelRef: "test/ghost", label: "G", costTier: 1, strengthTier: 1 }],
	};
	assert.equal(hasRouteableCandidate(missingModels, models, false), false);

	const noVision: RouterConfig = {
		...config,
		candidates: [{ modelRef: "test/mid", label: "M", costTier: 1, strengthTier: 1 }],
	};
	assert.equal(hasRouteableCandidate(noVision, models, true), false);
	assert.equal(hasRouteableCandidate(noVision, models, false), true);

	// When it is false, every possible analysis falls back — which is what makes skipping
	// the request equivalent, so assert that equivalence rather than assume it.
	for (const taskAnalysis of [
		analysis(),
		analysis({ taskType: "build", complexity: 5, risk: 5, needsVision: true }),
		analysis({ taskType: "review", complexity: 3, risk: 2 }),
	]) {
		const d = decideRoute({
			taskText: "t",
			hasImages: taskAnalysis.needsVision,
			analysis: taskAnalysis,
			config: missingModels,
			availableModels: models,
			currentModel: { provider: "test", id: "mid", name: "mid", reasoning: true, input: ["text"], contextWindow: 1 },
		});
		assert.equal(d.fromJev, false);
		assert.equal(d.modelRef, "test/mid");
	}
}

// 8. Confidence and failure info are carried on the decision for calibration and
//    troubleshooting, without affecting which model is picked.
{
	const withConfidence = decideRoute({
		taskText: "hi",
		hasImages: false,
		analysis: analysis(),
		confidence: 0.42,
		config,
		availableModels: models,
	});
	assert.equal(withConfidence.confidence, 0.42);
	assert.equal(withConfidence.modelRef, "test/cheap");
	assert.equal(withConfidence.failure, undefined);

	assert.equal(
		decideRoute({ taskText: "hi", hasImages: false, analysis: analysis(), config, availableModels: models }).confidence,
		undefined,
	);

	const failure = { category: "timeout" as const, message: "Jev request timed out", elapsedMs: 5001 };
	const fellBack = decideRoute({
		taskText: "hi",
		hasImages: false,
		config,
		availableModels: models,
		currentModel: { provider: "test", id: "mid", name: "mid", reasoning: true, input: ["text"], contextWindow: 1 },
		noAnalysisReason: "没有可用的候选模型，使用当前模型",
		failure,
	});
	assert.equal(fellBack.fromJev, false);
	assert.equal(fellBack.reason, "没有可用的候选模型，使用当前模型");
	assert.deepEqual(fellBack.failure, failure);

	// The default reason still applies when the caller does not supply one.
	assert.equal(
		decideRoute({ taskText: "hi", hasImages: false, config, availableModels: models }).reason,
		"Jev 不可用，使用当前模型",
	);
}

// 9. A candidate pinned to "off" keeps its level and gains no capability boost, so it is
//    still eligible for simple work (this is the value the validator used to reject).
{
	const pinned: RouterConfig = {
		...config,
		candidates: [
			{ modelRef: "test/mid", label: "Mid off", costTier: 1, strengthTier: 4, thinkingLevel: "off" },
			{ modelRef: "test/strong", label: "Strong", costTier: 5, strengthTier: 5 },
		],
	};
	assert.equal(
		decideRoute({ taskText: "hi", hasImages: false, analysis: analysis({ complexity: 3 }), config: pinned, availableModels: models })
			.modelRef,
		"test/mid",
		"a pinned 'off' keeps the cheap candidate eligible",
	);
	const decision = decideRoute({
		taskText: "hi",
		hasImages: false,
		analysis: analysis({ complexity: 2 }),
		config: pinned,
		availableModels: models,
	});
	assert.equal(decision.modelRef, "test/mid");
	assert.equal(decision.thinkingLevel, "off");
	assert.equal(planRouteApplication(decision, "auto", false, "test/other").applyThinkingLevel, true);
}

// 6b. An under-specified task (analysis.sufficient === false) must not change the model or
//     the level: the recommendation stays advisory. Previewing it against `noLevel`, the
//     gate applies on top of the normal "already active" logic.
{
	const insufficient = {
		modelRef: "test/strong",
		thinkingLevel: "high" as const,
		label: "S",
		reason: "r",
		fromJev: true,
		analysis: analysis({ complexity: 5, sufficient: false }),
	};
	for (const current of ["test/mid", "test/strong", undefined]) {
		assert.deepEqual(
			planRouteApplication(insufficient, "auto", false, current),
			{ switchModel: false, applyThinkingLevel: false, advisory: true, advisoryReason: "insufficient" },
			`advisory decision must not act (current=${current})`,
		);
	}
	// A sufficient analysis of the same shape still applies.
	const sufficient = { ...insufficient, analysis: analysis({ complexity: 5 }) };
	assert.deepEqual(planRouteApplication(sufficient, "auto", false, "test/mid"), {
		switchModel: true,
		applyThinkingLevel: true,
		advisory: false,
	});
	// A missing analysis (fallback decision) is not "insufficient": no advisory flag.
	const plain = { modelRef: "test/mid", label: "M", reason: "r", fromJev: false };
	assert.equal(planRouteApplication(plain, "auto", false, undefined).advisory, false);
}

// 6c. Policy knobs: `insufficientPolicy: "route"` acts anyway, and `minConfidence` adds an
//     independent gate that only applies when the analyzer reported a confidence.
{
	const insufficient = {
		modelRef: "test/strong",
		thinkingLevel: "high" as const,
		label: "S",
		reason: "r",
		fromJev: true,
		analysis: analysis({ complexity: 5, sufficient: false }),
		confidence: 0.9,
	};
	assert.deepEqual(
		planRouteApplication(insufficient, "auto", false, "test/mid", { insufficientPolicy: "route", minConfidence: 0 }),
		{ switchModel: true, applyThinkingLevel: true, advisory: false },
		"route policy keeps the old behaviour",
	);

	const sufficient = { ...insufficient, analysis: analysis({ complexity: 5 }) };
	const lowConfidence = { ...sufficient, confidence: 0.3 };
	assert.deepEqual(
		planRouteApplication(lowConfidence, "auto", false, "test/mid", { insufficientPolicy: "advisory", minConfidence: 0.5 }),
		{ switchModel: false, applyThinkingLevel: false, advisory: true, advisoryReason: "low-confidence" },
	);
	// Exactly at the threshold still passes; 0 disables the gate; a fallback decision has no
	// confidence and is never gated on it.
	assert.equal(
		planRouteApplication({ ...sufficient, confidence: 0.5 }, "auto", false, "test/mid", { insufficientPolicy: "advisory", minConfidence: 0.5 })
			.advisory,
		false,
	);
	const plainDecision = { modelRef: "test/mid", label: "M", reason: "r", fromJev: false };
	assert.equal(
		planRouteApplication(plainDecision, "auto", false, "test/mid", { insufficientPolicy: "advisory", minConfidence: 0.9 }).advisory,
		false,
	);
}

// 10. Pin 是下限，不是上限：复杂度可以把等级抬过 pin（让中档模型靠更强的推理处理 c4
//     任务），但简单任务不会压低 pin；pin 为 "off" 时绝对不可抬。
{
	const pinned: RouterConfig = {
		...config,
		candidates: [
			{ modelRef: "test/mid", label: "Mid medium", costTier: 2, strengthTier: 3, thinkingLevel: "medium" },
			{ modelRef: "test/strong", label: "Strong", costTier: 5, strengthTier: 5 },
		],
	};
	// complexity 4 → derived high；mid 的 medium pin 被抬到 high：3 + 1.4 = 4.4 ≥ 4 → 中档取代强档。
	const raised = decideRoute({
		taskText: "cross-module refactor",
		hasImages: false,
		analysis: analysis({ taskType: "refactor", complexity: 4, risk: 4 }),
		config: pinned,
		availableModels: models,
	});
	assert.equal(raised.modelRef, "test/mid", "a mid-tier candidate with raised level must beat the strong one for c4");
	assert.equal(raised.thinkingLevel, "high");

	// complexity 5 → derived xhigh；mid 3 + 1.8 = 4.8 < 5 → 强档仍然胜出。
	const c5 = decideRoute({
		taskText: "hard debugging",
		hasImages: false,
		analysis: analysis({ taskType: "debug", complexity: 5, risk: 3 }),
		config: pinned,
		availableModels: models,
	});
	assert.equal(c5.modelRef, "test/strong");

	// 简单任务不压低 pin：complexity 1 → derived undefined → mid 仍是 medium。
	assert.equal(
		decideRoute({ taskText: "hi", hasImages: false, analysis: analysis({ complexity: 1 }), config: pinned, availableModels: models })
			.thinkingLevel,
		"medium",
	);
	// complexity 2 → derived low < medium pin → 中档仍是 medium。
	{
		const simpleConfig: RouterConfig = {
			...config,
			candidates: [{ modelRef: "test/mid", label: "Mid medium", costTier: 2, strengthTier: 3, thinkingLevel: "medium" }],
		};
		const d = decideRoute({ taskText: "t", hasImages: false, analysis: analysis({ complexity: 2 }), config: simpleConfig, availableModels: models });
		assert.equal(d.thinkingLevel, "medium", "a simple task must not lower the pin");
	}
	// pin 为 "off" 是绝对的：complexity 5 也不能抬。
	{
		const offConfig: RouterConfig = {
			...config,
			candidates: [{ modelRef: "test/mid", label: "Off", costTier: 1, strengthTier: 1, thinkingLevel: "off" }],
		};
		const d = decideRoute({ taskText: "t", hasImages: false, analysis: analysis({ complexity: 5 }), config: offConfig, availableModels: models });
		assert.equal(d.thinkingLevel, "off", "a pinned 'off' must never be raised");
	}
}

console.log("router.test: all assertions passed");
