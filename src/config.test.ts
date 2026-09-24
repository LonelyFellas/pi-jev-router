/**
 * Config validation tests (pure, no filesystem).
 * Run: npx tsx src/config.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_CONFIG, mergeConfig, parseRouterConfig } from "./config.ts";

// 1. A valid file passes through with no issues.
{
	const { patch, issues } = parseRouterConfig({
		mode: "shadow",
		fallbackModelRef: "test/mid",
		candidates: [
			{
				modelRef: "test/mid",
				label: "Mid",
				costTier: 3,
				strengthTier: 3,
				thinkingLevel: "medium",
				taskTypes: ["review"],
			},
		],
		jev: {
			baseUrl: "https://api.typesafe.ai",
			apiKey: "$TYPESAFE_API_KEY",
			apiKeyEnv: "TYPESAFE_API_KEY",
			timeoutMs: 5000,
		},
	});
	assert.deepEqual(issues, []);
	assert.equal(patch.mode, "shadow");
	assert.equal(patch.fallbackModelRef, "test/mid");
	assert.deepEqual(patch.candidates, [
		{ modelRef: "test/mid", label: "Mid", costTier: 3, strengthTier: 3, thinkingLevel: "medium", taskTypes: ["review"] },
	]);
	assert.deepEqual(patch.jev, {
		baseUrl: "https://api.typesafe.ai",
		apiKey: "$TYPESAFE_API_KEY",
		apiKeyEnv: "TYPESAFE_API_KEY",
		timeoutMs: 5000,
	});
}

// 2. Invalid values are reported and omitted, so the default survives instead.
{
	const { patch, issues } = parseRouterConfig({
		mode: "banana",
		candidates: "nope",
		fallbackModelRef: "",
		jev: { baseUrl: "not-a-url", apiKeyEnv: "", timeoutMs: 0 },
	});
	assert.equal(patch.mode, undefined);
	assert.equal(patch.candidates, undefined);
	assert.equal(patch.fallbackModelRef, undefined);
	assert.equal(patch.jev, undefined);
	assert.equal(issues.length, 6, issues.join(" | "));
	assert.match(issues.join("\n"), /mode 非法/);
	assert.match(issues.join("\n"), /candidates 不是数组/);
	assert.match(issues.join("\n"), /jev\.timeoutMs 必须是正有限数/);
}

// 3. One bad candidate is dropped; the others still route. A missing label defaults.
{
	const { patch, issues } = parseRouterConfig({
		candidates: [
			{ modelRef: "test/ok", label: "Ok", costTier: 1, strengthTier: 1 },
			{ modelRef: "test/nolabel", costTier: 2, strengthTier: 2 },
			{ modelRef: "test/tier", costTier: "high", strengthTier: 1 },
			{ modelRef: "test/level", costTier: 1, strengthTier: 1, thinkingLevel: "turbo" },
			{ modelRef: "test/types", costTier: 1, strengthTier: 1, taskTypes: ["nope"] },
			{ modelRef: "test/empty-types", costTier: 1, strengthTier: 1, taskTypes: [] },
			null,
		],
	});
	assert.deepEqual(
		patch.candidates?.map((candidate) => [candidate.modelRef, candidate.label]),
		[
			["test/ok", "Ok"],
			["test/nolabel", "test/nolabel"],
		],
	);
	assert.equal(issues.length, 5, issues.join(" | "));
	assert.match(issues.join("\n"), /thinkingLevel 非法.*可选 off\/minimal/);
}

// 3b. "off" is a legal pin: pi accepts it at runtime (`getSupportedThinkingLevels` returns
//     it for reasoning models), so it must not drop the candidate.
{
	const { patch, issues } = parseRouterConfig({
		candidates: [{ modelRef: "test/off", label: "Off", costTier: 2, strengthTier: 2, thinkingLevel: "off" }],
	});
	assert.deepEqual(issues, []);
	assert.equal(patch.candidates?.[0]?.thinkingLevel, "off");
}

// 3c. Unknown keys are reported: a misspelled `candidate` would otherwise mean "no
//     candidates" with no explanation. `$`-prefixed keys (JSON schema) stay quiet.
{
	const { patch, issues } = parseRouterConfig({
		$schema: "./schema.json",
		candidate: [{ modelRef: "test/mid", costTier: 1, strengthTier: 1 }],
		jev: { baseUrl: "https://api.typesafe.ai", timeout: 5000 },
	});
	assert.equal(patch.candidates, undefined);
	assert.deepEqual(patch.jev, { baseUrl: "https://api.typesafe.ai" }, "valid keys still pass through");
	assert.equal(issues.length, 2, issues.join(" | "));
	assert.match(issues.join("\n"), /未知字段 candidate/);
	assert.match(issues.join("\n"), /未知字段 jev\.timeout/);
}

// 4. Layering: a later file overrides only the keys it actually sets.
{
	const global = mergeConfig(DEFAULT_CONFIG, parseRouterConfig({ mode: "shadow", jev: { timeoutMs: 9000 } }).patch);
	const project = mergeConfig(global, parseRouterConfig({ mode: "auto" }).patch);
	assert.equal(project.jev.timeoutMs, 9000, "a project file without jev must not reset the global timeout");
	assert.equal(project.mode, "auto");
	assert.equal(project.jev.baseUrl, DEFAULT_CONFIG.jev.baseUrl);

	const fallback = mergeConfig(project, parseRouterConfig({ fallbackModelRef: "test/mid" }).patch);
	assert.equal(fallback.fallbackModelRef, "test/mid");
}

// 5. Non-object roots and absent input are handled without throwing.
{
	assert.deepEqual(parseRouterConfig(undefined), { patch: {}, issues: [] });
	const array = parseRouterConfig([1, 2]);
	assert.deepEqual(array.patch, {});
	assert.equal(array.issues.length, 1);
	const scalar = parseRouterConfig("shadow");
	assert.equal(scalar.issues.length, 1);
}

// 6. API key sources stay opaque strings: validation must not resolve or unwrap them.
{
	const { patch, issues } = parseRouterConfig({ jev: { apiKey: "!security find-generic-password -w -s jev" } });
	assert.deepEqual(issues, []);
	assert.equal(patch.jev?.apiKey, "!security find-generic-password -w -s jev");
}

// 7. Policy fields: valid values pass through, invalid ones are reported and omitted.
{
	const { patch, issues } = parseRouterConfig({ insufficientPolicy: "route", minConfidence: 0.4 });
	assert.deepEqual(issues, []);
	assert.equal(patch.insufficientPolicy, "route");
	assert.equal(patch.minConfidence, 0.4);

	const invalid = parseRouterConfig({ insufficientPolicy: "guess", minConfidence: 2 });
	assert.equal(invalid.patch.insufficientPolicy, undefined);
	assert.equal(invalid.patch.minConfidence, undefined);
	assert.equal(invalid.issues.length, 2, invalid.issues.join(" | "));
	assert.match(invalid.issues.join("\n"), /insufficientPolicy 非法.*可选 advisory\/route/);
	assert.match(invalid.issues.join("\n"), /minConfidence 必须是 0–1 的有限数/);

	assert.equal(mergeConfig(DEFAULT_CONFIG, parseRouterConfig({}).patch).insufficientPolicy, "advisory");
	assert.equal(mergeConfig(DEFAULT_CONFIG, parseRouterConfig({}).patch).minConfidence, 0);
}

console.log("config.test: all assertions passed");
