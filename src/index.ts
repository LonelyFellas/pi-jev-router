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
import { analyzeTask } from "./jev.ts";
import { decideRoute } from "./router.ts";
import type { AnyModel, RouteDecision, RouteMode, RouterConfig } from "./types.ts";

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

	function updateStatus(ctx: ExtensionContext) {
		if (state.mode === "locked") {
			ctx.ui.setStatus(STATUS_KEY, "route: locked");
			return;
		}
		if (state.decision) {
			const d = state.decision;
			const level = d.thinkingLevel ? `/${d.thinkingLevel}` : "";
			const prefix = state.mode === "shadow" ? "route(shadow)" : "route";
			ctx.ui.setStatus(STATUS_KEY, `${prefix}: ${shortRef(d.modelRef)}${level}`);
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

	async function applyDecision(decision: RouteDecision, ctx: ExtensionContext): Promise<boolean> {
		const model = availableModels(ctx).find(
			(m) => `${m.provider}/${m.id}` === decision.modelRef,
		);
		if (!model) return false;
		applyingOwnSwitch = true;
		try {
			const ok = await pi.setModel(model);
			if (!ok) return false;
			if (decision.thinkingLevel) {
				pi.setThinkingLevel(decision.thinkingLevel);
			}
			return true;
		} finally {
			applyingOwnSwitch = false;
		}
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
		} catch {
			decision = decideRoute({
				taskText: text,
				hasImages,
				config,
				availableModels: models,
				currentModel: ctx.model,
			});
		}

		if (!decision.modelRef) {
			state = { ...state, routed: true, decision };
			persist();
			updateStatus(ctx);
			return;
		}

		const already = ctx.model && decision.modelRef === `${ctx.model.provider}/${ctx.model.id}`;

		if (state.mode === "auto" && !state.userOverrode && !already) {
			const applied = await applyDecision(decision, ctx);
			if (!applied) {
				decision = { ...decision, reason: `${decision.reason}（切换失败，保留当前模型）` };
			}
		}

		state = { ...state, routed: true, decision };
		persist();
		updateStatus(ctx);

		const level = decision.thinkingLevel ? ` · ${decision.thinkingLevel}` : "";
		const verb = state.mode === "shadow" ? "建议" : already ? "保持" : "已选择";
		ctx.ui.notify(`路由${verb}：${shortRef(decision.modelRef)}${level} — ${decision.reason}`, "info");
	}

	pi.on("session_start", async (_event, ctx) => {
		config = await loadConfig(ctx.cwd, homedir());
		// Config file provides the default mode; persisted session entries override it.
		state = { ...state, mode: config.mode };
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
		// A user-initiated change during routing takes precedence. Ignore our own
		// switch and startup-time default selection (no model was active yet).
		if (event.source === "set" && routingInFlight && hadModelAtRouteStart && !applyingOwnSwitch) {
			state = { ...state, userOverrode: true };
		}
		if (state.mode === "locked") {
			updateStatus(ctx);
		}
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
			];
			if (d) {
				lines.push(`模型：${d.modelRef}${d.thinkingLevel ? ` (${d.thinkingLevel})` : ""}`);
				lines.push(`原因：${d.reason}`);
				lines.push(`来源：${d.fromJev ? "Jev" : "回退"}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
