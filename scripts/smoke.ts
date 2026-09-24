/**
 * 端到端冒烟测试：Jev 分析 + 路由决策（不经过 pi UI）。
 * 运行：npx tsx scripts/smoke.ts
 * 需要：Jev 凭证已配置（默认 TYPESAFE_API_KEY，或 jev.apiKey 凭证来源）；~/.pi/agent/pi-jev-router.json 已配置。
 */
import { homedir } from "node:os";
import { loadConfig } from "../src/config.ts";
import { analyzeTask, describeFailure } from "../src/jev.ts";
import { decideRoute } from "../src/router.ts";
import { MODELS } from "./models.ts";

// 与 ~/.pi/agent/pi-jev-router.json 候选对应的最小模型信息
const TASKS: Array<{ text: string; hasImages: boolean }> = [
	{ text: "TypeScript 里 readonly 数组怎么定义？", hasImages: false },
	{ text: "修复登录过期后页面一直转圈的问题", hasImages: false },
	{ text: "这个截图里的布局错位了，帮我看看怎么回事", hasImages: true },
	{ text: "把前端登录态管理和后端 session 续期逻辑整体重构，统一前后端的过期处理", hasImages: false },
];

const { config, issues } = await loadConfig(process.cwd(), homedir());
if (issues.length > 0) {
	console.log(`配置问题：\n  ${issues.join("\n  ")}`);
}

for (const task of TASKS) {
	const start = Date.now();
	try {
		const result = await analyzeTask(task.text, task.hasImages, config);
		const decision = decideRoute({
			taskText: task.text,
			hasImages: task.hasImages,
			analysis: result.analysis,
			confidence: result.confidence,
			config,
			availableModels: MODELS,
		});
		const ms = Date.now() - start;
		const a = result.analysis;
		console.log(`\n任务: ${task.text.slice(0, 40)}${task.text.length > 40 ? "…" : ""}`);
		console.log(
			`  Jev: ${a.taskType} · 复杂度${a.complexity} · 风险${a.risk} · 置信度${result.confidence.toFixed(2)} · ${ms}ms`,
		);
		console.log(`  路由: ${decision.modelRef}${decision.thinkingLevel ? `/${decision.thinkingLevel}` : ""} (${decision.label})`);
	} catch (error) {
		const failure = describeFailure(error, Date.now() - start);
		console.log(
			`\n任务: ${task.text.slice(0, 40)} → 失败[${failure.category}${failure.status ? ` ${failure.status}` : ""}] ${failure.elapsedMs}ms: ${failure.message}`,
		);
	}
}
