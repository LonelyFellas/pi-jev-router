import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
	RouteCandidate,
	RouteMode,
	RouterConfig,
	TaskType,
	ThinkingLevel,
} from "./types.ts";

const MODES: RouteMode[] = ["auto", "locked", "shadow"];
// `ThinkingLevel` excludes "off"; a candidate either pins a level or derives one.
// Mirrors what pi accepts at runtime, so a candidate can be pinned to "off" (no thinking).
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const TASK_TYPES: TaskType[] = ["qa", "docs", "refactor", "bugfix", "debug", "review", "build"];
const CONFIG_KEYS = new Set(["mode", "candidates", "fallbackModelRef", "jev"]);
const JEV_KEYS = new Set(["baseUrl", "apiKey", "apiKeyEnv", "timeoutMs"]);

export const DEFAULT_CONFIG: RouterConfig = {
	mode: "auto",
	fallbackModelRef: undefined,
	candidates: [],
	jev: {
		baseUrl: "https://api.typesafe.ai",
		apiKeyEnv: "TYPESAFE_API_KEY",
		timeoutMs: 5000,
	},
};

/** A validated subset of a config file: only keys that survived validation. */
export interface ConfigPatch {
	mode?: RouteMode;
	candidates?: RouteCandidate[];
	fallbackModelRef?: string;
	jev?: Partial<RouterConfig["jev"]>;
}

export interface ParsedConfig {
	patch: ConfigPatch;
	/** Human-readable problems, each naming the field and what was used instead. */
	issues: string[];
}

export interface LoadedConfig {
	config: RouterConfig;
	issues: string[];
}

/** Unknown keys are reported: a typo like `candidate` would silently mean "no candidates". */
function unknownKeys(source: Record<string, unknown>, known: Set<string>, prefix = ""): string[] {
	return Object.keys(source)
		.filter((key) => !known.has(key) && !key.startsWith("$"))
		.map((key) => `未知字段 ${prefix}${key}（已忽略）`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function tier(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 5 ? value : undefined;
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** Validate one candidate. Invalid entries are dropped rather than poisoning routing. */
function parseCandidate(value: unknown, index: number, issues: string[]): RouteCandidate | undefined {
	const where = `candidates[${index}]`;
	if (!isRecord(value)) {
		issues.push(`${where}: 不是对象，已忽略`);
		return undefined;
	}
	const modelRef = nonEmptyString(value.modelRef);
	if (!modelRef) {
		issues.push(`${where}: modelRef 缺失或不是非空字符串，已忽略`);
		return undefined;
	}
	const costTier = tier(value.costTier);
	const strengthTier = tier(value.strengthTier);
	if (costTier === undefined || strengthTier === undefined) {
		issues.push(`${where} (${modelRef}): costTier/strengthTier 必须是 1–5 的整数，已忽略该候选`);
		return undefined;
	}

	let thinkingLevel: ThinkingLevel | undefined;
	if (value.thinkingLevel !== undefined) {
		const level = nonEmptyString(value.thinkingLevel);
		if (!level || !THINKING_LEVELS.includes(level as ThinkingLevel)) {
			issues.push(
				`${where} (${modelRef}): thinkingLevel 非法（${JSON.stringify(value.thinkingLevel)}），可选 ${THINKING_LEVELS.join("/")}，已忽略该候选`,
			);
			return undefined;
		}
		thinkingLevel = level as ThinkingLevel;
	}

	let taskTypes: TaskType[] | undefined;
	if (value.taskTypes !== undefined) {
		const list = Array.isArray(value.taskTypes) ? value.taskTypes : [];
		const invalid = list.filter((entry) => typeof entry !== "string" || !TASK_TYPES.includes(entry as TaskType));
		if (list.length === 0 || invalid.length > 0) {
			issues.push(`${where} (${modelRef}): taskTypes 必须是非空的任务类型数组，已忽略该候选`);
			return undefined;
		}
		taskTypes = list as TaskType[];
	}

	return {
		modelRef,
		label: nonEmptyString(value.label) ?? modelRef,
		costTier,
		strengthTier,
		...(thinkingLevel && { thinkingLevel }),
		...(taskTypes && { taskTypes }),
	};
}

/**
 * Validate a parsed config file. Nothing is asserted into `RouterConfig`: every field is
 * checked, invalid values are reported and left out of the patch, so a typo degrades one
 * candidate instead of silently producing an unusable configuration.
 */
export function parseRouterConfig(raw: unknown): ParsedConfig {
	const issues: string[] = [];
	const patch: ConfigPatch = {};

	if (raw === undefined) return { patch, issues };
	if (!isRecord(raw)) {
		issues.push("配置根节点不是对象，已忽略该文件内容");
		return { patch, issues };
	}
	issues.push(...unknownKeys(raw, CONFIG_KEYS));

	if (raw.mode !== undefined) {
		if (typeof raw.mode === "string" && MODES.includes(raw.mode as RouteMode)) {
			patch.mode = raw.mode as RouteMode;
		} else {
			issues.push(`mode 非法（${JSON.stringify(raw.mode)}），已使用默认值 ${DEFAULT_CONFIG.mode}`);
		}
	}

	if (raw.candidates !== undefined) {
		if (!Array.isArray(raw.candidates)) {
			issues.push("candidates 不是数组，已忽略");
		} else {
			const candidates: RouteCandidate[] = [];
			raw.candidates.forEach((entry, index) => {
				const candidate = parseCandidate(entry, index, issues);
				if (candidate) candidates.push(candidate);
			});
			patch.candidates = candidates;
		}
	}

	if (raw.fallbackModelRef !== undefined) {
		const fallbackModelRef = nonEmptyString(raw.fallbackModelRef);
		if (fallbackModelRef) patch.fallbackModelRef = fallbackModelRef;
		else issues.push("fallbackModelRef 不是非空字符串，已忽略");
	}

	const jev: Partial<RouterConfig["jev"]> = {};
	if (raw.jev !== undefined) {
		if (!isRecord(raw.jev)) {
			issues.push("jev 不是对象，已忽略");
		} else {
			const source = raw.jev;
			issues.push(...unknownKeys(source, JEV_KEYS, "jev."));
			if (source.baseUrl !== undefined) {
				const baseUrl = nonEmptyString(source.baseUrl);
				if (baseUrl && isHttpUrl(baseUrl)) jev.baseUrl = baseUrl;
				else issues.push(`jev.baseUrl 非法（${JSON.stringify(source.baseUrl)}），已忽略`);
			}
			if (source.apiKey !== undefined) {
				const apiKey = nonEmptyString(source.apiKey);
				if (apiKey) jev.apiKey = apiKey;
				else issues.push("jev.apiKey 不是非空字符串，已忽略");
			}
			if (source.apiKeyEnv !== undefined) {
				const apiKeyEnv = nonEmptyString(source.apiKeyEnv);
				if (apiKeyEnv) jev.apiKeyEnv = apiKeyEnv;
				else issues.push("jev.apiKeyEnv 不是非空字符串，已忽略");
			}
			if (source.timeoutMs !== undefined) {
				const timeoutMs = source.timeoutMs;
				if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0) {
					jev.timeoutMs = timeoutMs;
				} else {
					issues.push(`jev.timeoutMs 必须是正有限数（${JSON.stringify(timeoutMs)}），已忽略`);
				}
			}
		}
	}
	if (Object.keys(jev).length > 0) patch.jev = jev;

	return { patch, issues };
}

/** Layered merge: later layers override only the keys they actually validated. */
export function mergeConfig(base: RouterConfig, patch: ConfigPatch): RouterConfig {
	return {
		...base,
		...patch,
		jev: { ...base.jev, ...(patch.jev ?? {}) },
	};
}

/**
 * Load router config from:
 *   1. ~/.pi/agent/pi-jev-router.json (global)
 *   2. .pi/pi-jev-router.json (project-local, overrides; only for trusted projects)
 * Falls back to defaults. Missing files are fine; invalid values are reported in `issues`.
 */
export async function loadConfig(cwd: string, home: string, includeProject = true): Promise<LoadedConfig> {
	let config = DEFAULT_CONFIG;
	const issues: string[] = [];
	const paths = [join(home, CONFIG_DIR_NAME, "agent", "pi-jev-router.json")];
	if (includeProject) paths.push(join(cwd, CONFIG_DIR_NAME, "pi-jev-router.json"));

	for (const path of paths) {
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch {
			continue; // Missing file: keep the layered config as is.
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			issues.push(`${path}: JSON 解析失败，已忽略该文件`);
			continue;
		}
		const result = parseRouterConfig(parsed);
		config = mergeConfig(config, result.patch);
		issues.push(...result.issues.map((issue) => `${path}: ${issue}`));
	}

	return { config, issues };
}
