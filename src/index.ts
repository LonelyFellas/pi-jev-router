/**
 * pi-jev-router
 *
 * Routes the first task of a session to an appropriate model using the
 * Jev (TypeSafe System One) decision model.
 *
 * Modes:
 *   auto   - pick and switch automatically on the first user message
 *   locked - never switch; current model stays
 *   shadow - analyze and show recommendation, but do not switch
 *
 * Commands: /route, /route auto, /route lock, /route shadow, /route status
 */

import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { describeCredentialSource } from "./credentials.ts";
import { analyzeTask, describeFailure } from "./jev.ts";
import { decideRoute, hasRouteableCandidate, planRouteApplication } from "./router.ts";
import type { AnyModel, RouteDecision, RouteMode, RouterConfig, ThinkingLevel } from "./types.ts";

const STATE_TYPE = "pi-jev-router-state";
const STATUS_KEY = "jev-router";

interface SessionState {
	routed: boolean;
	mode: RouteMode;
	decision?: RouteDecision;
	userOverrode: boolean;
}

export default function (pi: ExtensionAPI) {
	let config: RouterConfig | undefined;
	let state: SessionState = { routed: false, mode: "auto", userOverrode: false };
	let routingInFlight: Promise<void> | undefined;
	let hadModelAtRouteStart = false;
	let applyingOwnSwitch = false;

	function availableModels(ctx: ExtensionContext): AnyModel[] {
		const scoped = ctx.scopedModels;
		if (scoped.length > 0) {
			return scoped.map((entry) => entry.model as AnyModel);
		}
		return ctx.modelRegistry.getAvailable() as AnyModel[];
	}

	function levelSuffix(level: ThinkingLevel | undefined): string {
		return level ? `/${level}` : "";
	}

	function updateStatus(ctx: ExtensionContext, actualModelRef?: string) {
		if (state.mode === "locked") {
			ctx.ui.setStatus(STATUS_KEY, "route: locked");
			return;
		}
		if (state.decision) {
			const d = state.decision;
			if (state.mode === "shadow") {
				// Shadow mode applies nothing; the status is a recommendation only.
				ctx.ui.setStatus(STATUS_KEY, `route(shadow): ${shortRef(d.modelRef)}${levelSuffix(d.thinkingLevel)}`);
				return;
			}
			// Auto mode: describe what is actually in use, keeping the model or level that was
			// only recommended visible when they diverge (failed switch, user override, advisory
			// decision, or pi clamping the level to what the model supports).
			const actualRef = actualModelRef ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "");
			if (d.advisory) {
				const shown = actualRef || d.modelRef;
				ctx.ui.setStatus(
					STATUS_KEY,
					`route: ${shortRef(shown)} (建议 ${shortRef(d.modelRef)}${levelSuffix(d.thinkingLevel)})`,
				);
				return;
			}
			if (actualRef && actualRef !== d.modelRef) {
				const suggested = d.effectiveThinkingLevel ?? d.thinkingLevel;
				ctx.ui.setStatus(
					STATUS_KEY,
					`route: ${shortRef(actualRef)} (建议 ${shortRef(d.modelRef)}${levelSuffix(suggested)})`,
				);
				return;
			}
			const effective = d.effectiveThinkingLevel ?? d.thinkingLevel;
			if (d.effectiveThinkingLevel && d.effectiveThinkingLevel !== d.thinkingLevel) {
				ctx.ui.setStatus(STATUS_KEY, `route: ${shortRef(d.modelRef)}${levelSuffix(effective)} (建议 ${d.thinkingLevel})`);
				return;
			}
			ctx.ui.setStatus(STATUS_KEY, `route: ${shortRef(d.modelRef)}${levelSuffix(effective)}`);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `route: ${state.mode}`);
	}

	function shortRef(ref: string): string {
		const parts = ref.split("/");
		return parts[parts.length - 1] ?? ref;
	}

	function persist() {
		pi.appendEntry(STATE_TYPE, { ...state });
	}

	async function switchModel(decision: RouteDecision, ctx: ExtensionContext): Promise<boolean> {
		const model = availableModels(ctx).find(
			(m) => `${m.provider}/${m.id}` === decision.modelRef,
		);
		if (!model) return false;
		applyingOwnSwitch = true;
		try {
			return await pi.setModel(model);
		} finally {
			applyingOwnSwitch = false;
		}
	}

	/**
	 * Apply the recommended thinking level independently of the model switch, so a
	 * recommendation for the already-active model is not dropped. Returns the level that is
	 * actually in effect, or undefined when there was nothing to change: pi clamps the
	 * requested level to what the model supports (e.g. xhigh → high).
	 */
	function applyThinkingLevel(decision: RouteDecision): ThinkingLevel | undefined {
		const requested = decision.thinkingLevel;
		if (!requested) return undefined;
		if (pi.getThinkingLevel() === requested) return undefined;
		pi.setThinkingLevel(requested);
		return pi.getThinkingLevel();
	}

	async function routeFirstTask(text: string, hasImages: boolean, ctx: ExtensionContext) {
		if (!config) return;
		if (state.mode === "locked") return;
		if (state.routed) return;

		const models = availableModels(ctx);
		if (models.length <= 1) {
			state = { ...state, routed: true };
			persist();
			return;
		}

		let decision: RouteDecision;
		if (!hasRouteableCandidate(config, models, hasImages)) {
			// No candidate can be picked for any analysis, so a Jev request would be billed
			// for a decision that is already determined: go straight to the fallback.
			decision = decideRoute({
				taskText: text,
				hasImages,
				config,
				availableModels: models,
				currentModel: ctx.model,
				noAnalysisReason: "没有可用的候选模型，使用当前模型",
			});
		} else {
			const startedAt = Date.now();
			try {
				const result = await analyzeTask(text, hasImages, config, ctx.signal);
				decision = decideRoute({
					taskText: text,
					hasImages,
					analysis: result.analysis,
					confidence: result.confidence,
					config,
					availableModels: models,
					currentModel: ctx.model,
				});
			} catch (error) {
				if (ctx.signal?.aborted) {
					// The task was cancelled: leave the session unrouted so the next task can be
					// routed, and never switch models on behalf of an abandoned request.
					return;
				}
				const failure = describeFailure(error, Date.now() - startedAt);
				decision = decideRoute({
					taskText: text,
					hasImages,
					config,
					availableModels: models,
					currentModel: ctx.model,
					noAnalysisReason: `Jev 不可用（${failure.category}${failure.status ? ` ${failure.status}` : ""}，${failure.elapsedMs}ms），使用当前模型`,
					failure,
				});
			}
		}

		if (!decision.modelRef) {
			state = { ...state, routed: true, decision };
			persist();
			updateStatus(ctx);
			return;
		}

		const currentModelRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		const already = currentModelRef !== undefined && currentModelRef === decision.modelRef;
		const plan = planRouteApplication(decision, state.mode, state.userOverrode, currentModelRef);

		let switchFailed = false;
		if (plan.switchModel) {
			switchFailed = !(await switchModel(decision, ctx));
			if (switchFailed) {
				decision = { ...decision, reason: `${decision.reason}（切换失败，保留当前模型）` };
			}
		}
		// Applying the level must not depend on whether the model changed. Skipped only when
		// the switch failed, because the level belongs to the model we never reached.
		const appliedLevel = plan.applyThinkingLevel && !switchFailed ? applyThinkingLevel(decision) : undefined;
		if (appliedLevel && appliedLevel !== decision.thinkingLevel) {
			decision = { ...decision, effectiveThinkingLevel: appliedLevel };
		}
		if (plan.advisory) {
			decision = { ...decision, advisory: true };
		}
		const activeRef =
			plan.switchModel && !switchFailed ? decision.modelRef : already ? decision.modelRef : undefined;

		state = { ...state, routed: true, decision };
		persist();
		updateStatus(ctx, activeRef);

		const shownLevel = decision.effectiveThinkingLevel ?? decision.thinkingLevel;
		const convergence = decision.effectiveThinkingLevel
			? `（${decision.thinkingLevel} 收敛为 ${decision.effectiveThinkingLevel}）`
			: "";
		const level = shownLevel ? ` · ${shownLevel}${convergence}` : "";
		let verb: string;
		if (state.mode === "shadow") verb = "建议";
		else if (switchFailed) verb = "切换失败，保持";
		else if (plan.advisory) verb = "描述不充分，保留当前模型";
		else if (state.userOverrode && !already) verb = "保留用户选择";
		else if (!already) verb = "已选择";
		else verb = appliedLevel ? "保持模型，调整推理强度" : "保持";
		ctx.ui.notify(`路由${verb}：${shortRef(decision.modelRef)}${level} — ${decision.reason}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		const loaded = await loadConfig(ctx.cwd, homedir(), ctx.isProjectTrusted());
		config = loaded.config;
		if (loaded.issues.length > 0) {
			// Invalid config must be visible: it changes routing silently otherwise.
			ctx.ui.notify(`pi-jev-router 配置问题：\n${loaded.issues.join("\n")}`, "warning");
		}
		// Rebuild from fresh defaults so state from another session cannot leak in.
		// Persisted entries from this session override the configured default mode.
		state = { routed: false, mode: config.mode, userOverrode: false };
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE) {
				state = { ...state, ...(entry.data as Partial<SessionState>) };
			}
		}
		updateStatus(ctx);
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return;
		if (state.routed || state.mode === "locked") return;
		if (!routingInFlight) {
			hadModelAtRouteStart = !!ctx.model;
			routingInFlight = routeFirstTask(event.text, (event.images?.length ?? 0) > 0, ctx).finally(() => {
				routingInFlight = undefined;
			});
		}
		await routingInFlight;
		return { action: "continue" };
	});

	pi.on("model_select", async (event, ctx) => {
		// A user-initiated change during routing takes precedence, whether it came from
		// /model ("set") or Ctrl+P cycling ("cycle"). Ignore our own switch and the
		// session restore selection, which is not a user intervention.
		if (event.source !== "restore" && routingInFlight && hadModelAtRouteStart && !applyingOwnSwitch) {
			state = { ...state, userOverrode: true };
		}
		// Refresh the status from the model that is now active.
		updateStatus(ctx);
	});

	pi.registerCommand("route", {
		description: "Jev model router: /route [auto|lock|shadow|status]",
		getArgumentCompletions: (prefix) => {
			const items = ["auto", "lock", "shadow", "status"].map((v) => ({ value: v, label: v }));
			return items.filter((i) => i.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "auto" || arg === "lock" || arg === "shadow") {
				const mode: RouteMode = arg === "lock" ? "locked" : arg;
				state = { ...state, mode, userOverrode: false };
				persist();
				updateStatus(ctx);
				ctx.ui.notify(`路由模式：${mode}`, "info");
				return;
			}
			const d = state.decision;
			const lines = [
				`模式：${state.mode}`,
				`已路由：${state.routed ? "是" : "否"}`,
				`用户覆盖：${state.userOverrode ? "是（保留当前模型）" : "否"}`,
			];
			if (config) {
				lines.push(
					`Jev key：${describeCredentialSource({
						configuredValue: config.jev.apiKey,
						environmentName: config.jev.apiKeyEnv,
					})}`,
				);
			}
			if (d) {
				const level = d.effectiveThinkingLevel ?? d.thinkingLevel;
				const convergence =
					d.effectiveThinkingLevel && d.thinkingLevel !== d.effectiveThinkingLevel
						? `，${d.thinkingLevel} 已收敛`
						: "";
				lines.push(`模型：${d.modelRef}${level ? ` (${level}${convergence})` : ""}`);
				lines.push(`原因：${d.reason}`);
				lines.push(`来源：${d.fromJev ? "Jev" : "回退"}`);
				if (d.analysis) {
					// Calibration data: recorded and displayed, but nothing routes on it yet.
					const confidence = d.confidence !== undefined ? ` · 置信度 ${d.confidence.toFixed(2)}` : "";
					lines.push(`分析：${d.analysis.taskType} · 描述充分 ${d.analysis.sufficient ? "是" : "否"}${confidence}`);
				}
				if (d.advisory) {
					lines.push("处理：描述不充分，保留当前模型（仅建议）");
				}
				if (d.failure) {
					const status = d.failure.status !== undefined ? ` ${d.failure.status}` : "";
					lines.push(`上次失败：${d.failure.category}${status} · ${d.failure.elapsedMs}ms`);
					lines.push(`失败详情：${d.failure.message}`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
