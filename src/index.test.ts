/**
 * Session initialization regression tests (isolated config, no network).
 * Run: node --experimental-strip-types src/index.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionHandler,
	type InputEvent,
	type ModelSelectEvent,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import extension from "./index.ts";
import type { ThinkingLevel } from "./types.ts";

const STATE_TYPE = "pi-jev-router-state";
const NO_JEV_KEY_ENV = "PI_JSV_ROUTER_TEST_MISSING_KEY";

/** Jev response fixture: complexity score 4 → complexity 5 → xhigh is the requested level. */
const JEV_RESPONSE = {
	model: "jev-latest",
	answers: {
		task_type: { type: "choice", choice: "build", confidence: 0.9, probabilities: {} },
		complexity: { type: "score", score: 4, confidence: 0.9, legend: {}, probabilities: {} },
		risk: { type: "score", score: 2, confidence: 0.9, legend: {}, probabilities: {} },
		sufficient: { type: "noul", noul: 1 },
	},
	usage: { input_tokens: 10, output_tokens: 5 },
};
const home = await mkdtemp(join(tmpdir(), "pi-jev-router-session-test-"));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const realFetch = globalThis.fetch;

try {
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	assert.equal(homedir(), home, "tests must not read real user configuration");
	// Point Jev at an env var that is guaranteed to be unset so the analyzer fails fast
	// and the tests never touch the network, even on a machine with a real key.
	delete process.env[NO_JEV_KEY_ENV];
	// This file must stay offline even if a real key is present in the environment. The stub is
	// the only fetch: "fail" keeps the analyzer failing, "ok" serves a canned Jev response.
	let fetchMode: "fail" | "ok" = "fail";
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		if (fetchMode === "fail") throw new Error("index.test must not perform network requests");
		return new Response(JSON.stringify(JEV_RESPONSE), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	const configDir = join(home, CONFIG_DIR_NAME, "agent");
	await mkdir(configDir, { recursive: true });
	await writeFile(
		join(configDir, "pi-jev-router.json"),
		JSON.stringify({ mode: "shadow", jev: { apiKeyEnv: NO_JEV_KEY_ENV } }),
	);

	const handlers = new Map<string, unknown>();
	let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
	const writes: unknown[] = [];
	const notifications: string[] = [];
	const setModelCalls: unknown[] = [];
	const available: unknown[] = [];
	let status: string | undefined;
	// pi clamps a requested level to what the model supports (pi-ai `clampThinkingLevel`):
	// xhigh/max collapse to high when `thinkingLevelMap` does not define them.
	const MODEL_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];
	let liveLevel: ThinkingLevel = "off";
	let entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
	const api = {
		on(event: string, handler: unknown) {
			handlers.set(event, handler);
			return () => {};
		},
		registerCommand(_name: string, options: NonNullable<typeof command>) {
			command = options;
		},
		appendEntry(type: string, data: unknown) {
			assert.equal(type, STATE_TYPE);
			writes.push(data);
		},
		async setModel(model: unknown) {
			setModelCalls.push(model);
			return true;
		},
		getThinkingLevel: () => liveLevel,
		setThinkingLevel(level: ThinkingLevel) {
			liveLevel = MODEL_LEVELS.includes(level) ? level : "high";
		},
	} satisfies Pick<
		ExtensionAPI,
		| "on"
		| "registerCommand"
		| "appendEntry"
		| "setModel"
		| "getThinkingLevel"
		| "setThinkingLevel"
	>;
	extension(api as unknown as ExtensionAPI);
	const ctx = {
		cwd: home,
		isProjectTrusted: () => false,
		sessionManager: { getEntries: () => entries },
		scopedModels: [],
		modelRegistry: { getAvailable: () => available },
		ui: {
			setStatus: (_key: string, value: string | undefined) => { status = value; },
			notify: (message: string) => { notifications.push(message); },
		},
	} as unknown as ExtensionContext;
	const start = handlers.get("session_start") as ExtensionHandler<SessionStartEvent>;
	const input = handlers.get("input") as ExtensionHandler<InputEvent>;
	const modelSelectEvent = {} as Omit<ModelSelectEvent, "model" | "previousModel"> & {
		model: unknown;
		previousModel: unknown;
	};
	const modelSelect = handlers.get("model_select") as ExtensionHandler<typeof modelSelectEvent>;
	assert.ok(command);
	const route = command;
	const getStatus = async () => {
		await route.handler("status", ctx as ExtensionCommandContext);
		return notifications.at(-1)!;
	};
	const decision = { modelRef: "test/previous", label: "Previous", reason: "saved", fromJev: true };

	// Reuse one factory deliberately to test handler reinitialization independently
	// of the host's usual extension recreation on session replacement.
	entries = [{ type: "custom", customType: STATE_TYPE, data: {
		routed: true, mode: "auto", decision, userOverrode: true,
	} }];
	await start({ type: "session_start", reason: "startup" }, ctx);
	assert.match(await getStatus(), /已路由：是/);
	assert.equal(status, "route: previous");

	// Empty new session: discard the previous decision/override and use config mode.
	entries = [];
	await start({ type: "session_start", reason: "new" }, ctx);
	assert.match(await getStatus(), /模式：shadow\n已路由：否/);
	assert.doesNotMatch(await getStatus(), /test\/previous/);
	assert.equal(status, "route: shadow");
	await input({ type: "input", source: "interactive", text: "first task" }, ctx);
	assert.deepEqual(writes, [{ routed: true, mode: "shadow", userOverrode: false }]);
	await input({ type: "input", source: "interactive", text: "second task" }, ctx);
	assert.equal(writes.length, 1, "only the first task is routed");

	// Resume/reload: persisted state still overrides defaults, latest entry wins.
	entries = [
		{ type: "custom", customType: STATE_TYPE, data: { mode: "locked" } },
		{ type: "custom", customType: STATE_TYPE, data: {
			routed: true, mode: "auto", decision, userOverrode: true,
		} },
	];
	for (const reason of ["resume", "reload"] as const) {
		await start({ type: "session_start", reason }, ctx);
		assert.match(await getStatus(), /模式：auto\n已路由：是/);
		assert.equal(status, "route: previous");
		await input({ type: "input", source: "interactive", text: "continue" }, ctx);
		assert.equal(writes.length, 1, "restored routed sessions must not route again");
	}

	// Partial saved entries must merge into fresh defaults, not the previous session.
	entries = [{ type: "custom", customType: STATE_TYPE, data: { mode: "auto" } }];
	await start({ type: "session_start", reason: "resume" }, ctx);
	assert.match(await getStatus(), /模式：auto\n已路由：否/);
	assert.equal(status, "route: auto");
	await input({ type: "input", source: "interactive", text: "first task" }, ctx);
	assert.deepEqual(writes.at(-1), { routed: true, mode: "auto", userOverrode: false });

	// A model the user picks while the first task is still being routed wins, whatever
	// the source: /model ("set") and Ctrl+P cycling ("cycle") are both user
	// interventions. A restore-time selection is not.
	{
		await writeFile(join(configDir, "pi-jev-router.json"), JSON.stringify({
			mode: "auto",
			fallbackModelRef: "test/fallback",
			candidates: [{ modelRef: "test/fallback", label: "Fallback", costTier: 1, strengthTier: 1 }],
			jev: { apiKeyEnv: NO_JEV_KEY_ENV },
		}));
		const currentModel = { provider: "test", id: "current", name: "current", reasoning: true, input: ["text"], contextWindow: 1 };
		const fallbackModel = { provider: "test", id: "fallback", name: "fallback", reasoning: true, input: ["text"], contextWindow: 1 };
		available.push(currentModel, fallbackModel);
		Object.assign(ctx, { model: currentModel });

		for (const [source, expectOverride] of [
			["restore", false],
			["cycle", true],
			["set", true],
		] as const) {
			const callsBefore = setModelCalls.length;
			entries = [];
			await start({ type: "session_start", reason: "new" }, ctx);
			const pending = input({ type: "input", source: "interactive", text: "first task" }, ctx);
			await modelSelect(
				{ type: "model_select", model: currentModel, previousModel: fallbackModel, source },
				ctx,
			);
			await pending;
			assert.match(await getStatus(), expectOverride ? /用户覆盖：是/ : /用户覆盖：否/);
			assert.match(await getStatus(), /来源：回退/, "the analyzer must fail fast instead of calling Jev");
			assert.equal(
				setModelCalls.length - callsBefore,
				expectOverride ? 0 : 1,
				`source "${source}" must ${expectOverride ? "not " : ""}be overridden by the router`,
			);
		}

		// A cancelled task must not switch models, and must leave the session unrouted so the
		// next task can still be routed.
		{
			const controller = new AbortController();
			controller.abort(new Error("task cancelled"));
			Object.assign(ctx, { signal: controller.signal });
			entries = [];
			await start({ type: "session_start", reason: "new" }, ctx);
			const callsBefore = setModelCalls.length;
			await input({ type: "input", source: "interactive", text: "first task" }, ctx);
			assert.equal(setModelCalls.length, callsBefore, "a cancelled task must not switch models");
			assert.match(await getStatus(), /已路由：否/);
			Object.assign(ctx, { signal: undefined });
		}

		// With no usable candidate the analysis cannot change the outcome, so the request is
		// skipped entirely: the session must still fall back, without a Jev failure.
		{
			await writeFile(
				join(configDir, "pi-jev-router.json"),
				JSON.stringify({ mode: "auto", fallbackModelRef: "test/fallback", candidates: [] }),
			);
			entries = [];
			await start({ type: "session_start", reason: "new" }, ctx);
			const callsBefore = setModelCalls.length;
			await input({ type: "input", source: "interactive", text: "first task" }, ctx);
			assert.equal(setModelCalls.length - callsBefore, 1, "the fallback model is still applied");
			const status = await getStatus();
			assert.match(status, /来源：回退/);
			assert.match(status, /原因：没有可用的候选模型/);
			assert.doesNotMatch(status, /上次失败/, "no analyzer request may be attempted for this task");
		}

		assert.equal(fetchCalls, 0, "routing paths that must not call the analyzer may not reach fetch");

		// A level pi clamps (xhigh → high on a model without xhigh support) must be reported as
		// the level actually in effect, not as the level we asked for.
		{
			fetchMode = "ok";
			await writeFile(
				join(configDir, "pi-jev-router.json"),
				JSON.stringify({
					mode: "auto",
					fallbackModelRef: "test/fallback",
					candidates: [{ modelRef: "test/fallback", label: "Fallback", costTier: 1, strengthTier: 1 }],
					jev: { apiKey: "test-key", apiKeyEnv: NO_JEV_KEY_ENV },
				}),
			);
			entries = [];
			await start({ type: "session_start", reason: "new" }, ctx);
			const callsBefore = setModelCalls.length;
			await input({ type: "input", source: "interactive", text: "first task" }, ctx);
			assert.equal(fetchCalls, 1, "the stub must have served exactly one canned response");
			assert.equal(setModelCalls.length - callsBefore, 1, "the routed model is applied");
			assert.equal(liveLevel, "high", "pi clamps xhigh to the supported high");
			assert.equal(status, "route: fallback/high (建议 xhigh)");
			assert.match(await getStatus(), /模型：test\/fallback \(high，xhigh 已收敛\)/);
			assert.match(notifications.join("\n"), /xhigh 收敛为 high/);
			fetchMode = "fail";
		}

		Object.assign(ctx, { signal: undefined });
	}

	console.log("index.test: all assertions passed");
} finally {
	globalThis.fetch = realFetch;
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	await rm(home, { recursive: true, force: true });
}
