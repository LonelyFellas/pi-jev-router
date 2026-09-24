/**
 * 评测用的最小模型表（与 ~/.pi/agent/pi-jev-router.json 的候选对应）。
 * 这里只保留决策需要的字段，避免依赖 pi 的模型目录。
 */
import type { AnyModel } from "../src/types.ts";

export const MODELS: AnyModel[] = [
	{ provider: "openai-codex", id: "gpt-5.3-codex-spark", name: "spark", reasoning: true, input: ["text"], contextWindow: 128_000 },
	{ provider: "deepseek", id: "deepseek-flash", name: "flash", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000 },
	{ provider: "cc-switch-kimi", id: "kimi-k2.7-code", name: "k2.7", reasoning: true, input: ["text", "image"], contextWindow: 262_144 },
	{ provider: "openai-codex", id: "gpt-5.6-sol", name: "sol", reasoning: true, input: ["text", "image"], contextWindow: 272_000 },
	{ provider: "openai-codex", id: "gpt-6-astra", name: "astra", reasoning: true, input: ["text", "image"], contextWindow: 1_000_000 },
] as AnyModel[];
