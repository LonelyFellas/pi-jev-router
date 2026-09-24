/**
 * 评测脚本：固定任务集 × Jev 分析 × 路由决策，产出可人工打分的记录。
 *
 * 默认只打印计划，不联网；加 --run 才会真正发起 Jev 请求（每个任务一次，会计费）。
 * 目的是给“成本与质量依据”收集数据：先记录推荐了什么、依据是什么、耗时与用量多少，
 * 再由人工补两列（结果可用性、是否返工），之后才谈调参。
 *
 * 用法：
 *   npx tsx scripts/eval.ts                          # 打印任务集与候选解析情况，不发请求
 *   npx tsx scripts/eval.ts --run                     # 运行，写入 eval-out/eval-results.jsonl 与 eval-ratings.csv
 *   npx tsx scripts/eval.ts --run --out /tmp/eval      # 指定输出目录
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { analyzeTask, describeFailure } from "../src/jev.ts";
import { decideRoute, hasRouteableCandidate } from "../src/router.ts";
import type { AnyModel, RouterConfig } from "../src/types.ts";
import { MODELS } from "./models.ts";

interface EvalTask {
	id: string;
	/** 覆盖意图：taskType / complexity，便于检查任务集是否均衡。 */
	covers: string;
	text: string;
	hasImages: boolean;
}

// 20 条任务，覆盖 7 种 taskType × 复杂度 1–5 × 3 个带图任务。
const TASKS: EvalTask[] = [
	{ id: "qa-1", covers: "qa/1", text: "TypeScript 里 readonly 数组怎么定义？", hasImages: false },
	{ id: "qa-3", covers: "qa/3", text: "解释一下我们这套扩展里 before_agent_start 和 input 两个钩子的执行顺序与差异", hasImages: false },
	{ id: "docs-1", covers: "docs/1", text: "把 README 里安装那一节的命令改成 pnpm", hasImages: false },
	{ id: "docs-3", covers: "docs/3", text: "给 router.ts 的决策流程写一份中文文档，说明候选筛选和能力档位怎么算", hasImages: false },
	{ id: "refactor-2", covers: "refactor/2", text: "把 config.ts 里的校验逻辑拆成独立函数，行为不变", hasImages: false },
	{ id: "refactor-4", covers: "refactor/4", text: "把凭证解析、配置加载、路由决策三层解耦，统一错误类型并保持现有测试全绿", hasImages: false },
	{ id: "bugfix-2", covers: "bugfix/2", text: "修复 /route status 在标签为空时显示 undefined 的问题", hasImages: false },
	{ id: "bugfix-3", covers: "bugfix/3", text: "修复登录过期后页面一直转圈的问题", hasImages: false },
	{ id: "debug-3", covers: "debug/3", text: "用户反馈偶发路由到错误模型，帮我定位是候选筛选还是分析结果的问题", hasImages: false },
	{ id: "debug-5", covers: "debug/5", text: "线上偶发请求超时且没有日志，涉及网关、鉴权和重试三层，帮我系统排查根因", hasImages: false },
	{ id: "review-2", covers: "review/2", text: "review 一下最近的 credentials.ts 改动有没有安全问题", hasImages: false },
	{ id: "review-4", covers: "review/4", text: "对 src/ 全量做一次安全与健壮性审查，重点是凭证处理、取消语义和错误分类", hasImages: false },
	{ id: "build-3", covers: "build/3", text: "给扩展加一个 /route history 命令，显示最近几次决策", hasImages: false },
	{ id: "build-5", covers: "build/5", text: "实现一个带有回退与度量上报的模型路由系统，含配置校验、失败分类和评测脚本", hasImages: false },
	{ id: "qa-2-vision", covers: "qa/2+vision", text: "这张图里的报错是什么意思？", hasImages: true },
	{ id: "debug-4-vision", covers: "debug/4+vision", text: "这个截图里的布局错位了，帮我看看哪里出了问题", hasImages: true },
	{ id: "build-4-vision", covers: "build/4+vision", text: "按这张设计稿把设置页搭出来，并对齐现有组件库风格", hasImages: true },
	{ id: "docs-2-en", covers: "docs/2", text: "Update the English section of the README to describe /route status output", hasImages: false },
	{ id: "bugfix-4-en", covers: "bugfix/4", text: "Fix the intermittent crash when the analyzer returns a non-finite score", hasImages: false },
	{ id: "build-2-en", covers: "build/2", text: "Add a unit test for the config validation helper", hasImages: false },
];

const RUN = process.argv.includes("--run");
const outIndex = process.argv.indexOf("--out");
let OUT_DIR = join(process.cwd(), "eval-out");
if (outIndex >= 0) {
	const value = process.argv[outIndex + 1];
	if (!value || value.startsWith("--")) {
		console.error("--out 需要一个目录参数，例如：--out /tmp/eval");
		process.exit(1);
	}
	OUT_DIR = value;
}

/** Minimal CSV reader for the file this script writes (quoted fields may contain commas). */
function parseCsv(text: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let quoted = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					field += '"';
					index += 1;
				} else {
					quoted = false;
				}
			} else {
				field += char;
			}
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === ",") {
			row.push(field);
			field = "";
		} else if (char === "\n") {
			row.push(field);
			rows.push(row);
			row = [];
			field = "";
		} else if (char !== "\r") field += char;
	}
	if (field.length > 0 || row.length > 0) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

interface Rating {
	useful?: number;
	rework?: boolean;
}

interface ResultRecord {
	id: string;
	elapsedMs: number;
	confidence: number | null;
	modelRef: string;
	thinkingLevel: string | null;
	complexity: number | null;
	sufficient: boolean | null;
}

async function readResults(dir: string): Promise<ResultRecord[]> {
	const text = await readFile(join(dir, "eval-results.jsonl"), "utf8");
	return text
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
		.map((row) => {
			const analysis = (row.analysis ?? {}) as Record<string, unknown>;
			const recommended = (row.recommended ?? {}) as Record<string, unknown>;
			return {
				id: String(row.id),
				elapsedMs: Number(row.elapsedMs ?? 0),
				confidence: typeof row.confidence === "number" ? row.confidence : null,
				modelRef: typeof recommended.modelRef === "string" ? recommended.modelRef : "(none)",
				thinkingLevel: typeof recommended.thinkingLevel === "string" ? recommended.thinkingLevel : null,
				complexity: typeof analysis.complexity === "number" ? analysis.complexity : null,
				sufficient: typeof analysis.sufficient === "boolean" ? analysis.sufficient : null,
			};
		});
}

async function readRatings(dir: string): Promise<Map<string, Rating>> {
	const ratings = new Map<string, Rating>();
	let text: string;
	try {
		text = await readFile(join(dir, "eval-ratings.csv"), "utf8");
	} catch {
		return ratings;
	}
	const rows = parseCsv(text);
	const header = rows[0] ?? [];
	const idColumn = header.indexOf("id");
	const usefulColumn = header.indexOf("useful_1_5");
	const reworkColumn = header.indexOf("rework");
	if (idColumn < 0) return ratings;
	for (const row of rows.slice(1)) {
		const id = row[idColumn];
		if (!id) continue;
		const useful = Number(row[usefulColumn]);
		const rework = (row[reworkColumn] ?? "").trim().toLowerCase();
		const rating: Rating = {};
		if (Number.isFinite(useful) && useful >= 1 && useful <= 5) rating.useful = useful;
		if (rework === "true" || rework === "yes" || rework === "1") rating.rework = true;
		else if (rework === "false" || rework === "no" || rework === "0") rating.rework = false;
		if (rating.useful !== undefined || rating.rework !== undefined) ratings.set(id, rating);
	}
	return ratings;
}

/** `rated_by` values per id, so predicted and observed ratings stay distinguishable. */
async function readRatingProvenance(dir: string): Promise<Map<string, string>> {
	const sources = new Map<string, string>();
	let text: string;
	try {
		text = await readFile(join(dir, "eval-ratings.csv"), "utf8");
	} catch {
		return sources;
	}
	const rows = parseCsv(text);
	const header = rows[0] ?? [];
	const idColumn = header.indexOf("id");
	const sourceColumn = header.indexOf("rated_by");
	if (idColumn < 0 || sourceColumn < 0) return sources;
	for (const row of rows.slice(1)) {
		const id = row[idColumn];
		const source = (row[sourceColumn] ?? "").trim();
		if (id && source) sources.set(id, source);
	}
	return sources;
}

/** Join the machine rows with the human columns and group by recommendation. */
async function report(dir: string): Promise<void> {
	let records: ResultRecord[];
	try {
		records = await readResults(dir);
	} catch {
		console.error(`未找到 ${join(dir, "eval-results.jsonl")}，先运行 npx tsx scripts/eval.ts --run`);
		process.exit(1);
	}
	const ratings = await readRatings(dir);
	const ratingSource = await readRatingProvenance(dir);
	const provenance = new Map<string, number>();

	interface Group {
		n: number;
		rated: number;
		usefulSum: number;
		rework: number;
		reworkRated: number;
		complexitySum: number;
		confidenceSum: number;
		confidenceCount: number;
		insufficient: number;
		elapsedSum: number;
	}
	const groups = new Map<string, Group>();
	let rated = 0;
	let usefulSum = 0;
	let usefulCount = 0;
	let rework = 0;
	let reworkRated = 0;

	for (const record of records) {
		const key = `${record.modelRef}/${record.thinkingLevel ?? "-"}`;
		const group = groups.get(key) ?? {
			n: 0,
			rated: 0,
			usefulSum: 0,
			rework: 0,
			reworkRated: 0,
			complexitySum: 0,
			confidenceSum: 0,
			confidenceCount: 0,
			insufficient: 0,
			elapsedSum: 0,
		};
		group.n += 1;
		group.elapsedSum += record.elapsedMs;
		if (record.complexity !== null) group.complexitySum += record.complexity;
		if (record.confidence !== null) {
			group.confidenceSum += record.confidence;
			group.confidenceCount += 1;
		}
		if (record.sufficient === false) group.insufficient += 1;

		const rating = ratings.get(record.id);
		if (rating) {
			group.rated += 1;
			if (rating.useful !== undefined) {
				group.usefulSum += rating.useful;
				usefulSum += rating.useful;
				usefulCount += 1;
			}
			if (rating.rework !== undefined) {
				group.reworkRated += 1;
				reworkRated += 1;
				if (rating.rework) {
					group.rework += 1;
					rework += 1;
				}
			}
			if (rating.useful !== undefined || rating.rework !== undefined) rated += 1;
			const source = (ratingSource.get(record.id) ?? "").trim();
			if (source) provenance.set(source, (provenance.get(source) ?? 0) + 1);
		}
		groups.set(key, group);
	}

	const percent = (value: number, total: number) => (total > 0 ? `${Math.round((value / total) * 100)}%` : "-");
	console.log(`汇总（${dir}）：样本 ${records.length}，已评分 ${rated}/${records.length}\n`);
	if (provenance.size > 0) {
		console.log(`评分来源：${[...provenance.entries()].map(([source, count]) => `${source} ${count}`).join(" · ")}`);
		if ([...provenance.keys()].some((source) => source !== "human")) {
			console.log("注意：非 human 来源是预测，不是实测结果，不能当作质量结论。\n");
		}
	}
	console.log("模型/等级               样本 评分  平均可用  返工率  平均复杂度  平均置信度  描述不充分  Jev耗时");
	for (const [key, group] of groups) {
		console.log(
			[
				key.padEnd(22),
				String(group.n).padStart(4),
				String(group.rated).padStart(4),
				(group.usefulSum > 0 ? (group.usefulSum / group.rated).toFixed(1) : "-").padStart(8),
				percent(group.rework, group.reworkRated).padStart(6),
				(group.complexitySum / group.n).toFixed(1).padStart(10),
				(group.confidenceCount > 0 ? (group.confidenceSum / group.confidenceCount).toFixed(2) : "-").padStart(10),
				String(group.insufficient).padStart(10),
				`${Math.round(group.elapsedSum / group.n)}ms`.padStart(8),
			].join(" "),
		);
	}
	console.log(
		`\n整体：平均可用性 ${usefulCount > 0 ? (usefulSum / usefulCount).toFixed(2) : "-"} · 返工率 ${percent(rework, reworkRated)} · 描述不充分 ${records.filter((r) => r.sufficient === false).length}/${records.length}`,
	);
	if (rated < records.length) {
		console.log(`提示：还有 ${records.length - rated} 条未评分，未评分样本不计入平均可用性与返工率。`);
	}
	console.log("说明：平均可用性来自人工列 useful_1_5；返工率来自 rework=true 的比例。两者都是质量列，");
	console.log("要与 costTier 比较才能说明“更省钱且质量足够”，单看 Jev 耗时与用量只是分析器开销。");
}

/**
 * Rating helper. Without an argument it prints the pending rows as a worksheet; with
 * `--rate "id=useful,rework; ..."` it writes them back, keeping the previous file as .bak.
 * Deliberately non-interactive: it stays scriptable and can be verified end to end.
 */
async function rate(dir: string, spec: string | undefined, provenance: string): Promise<void> {
	const csvPath = join(dir, "eval-ratings.csv");
	let text: string;
	try {
		text = await readFile(csvPath, "utf8");
	} catch {
		console.error(`未找到 ${csvPath}，先运行 npx tsx scripts/eval.ts --run`);
		process.exit(1);
	}
	const rows = parseCsv(text);
	const header = rows[0] ?? [];
	const idColumn = header.indexOf("id");
	const usefulColumn = header.indexOf("useful_1_5");
	const reworkColumn = header.indexOf("rework");
	if (idColumn < 0 || usefulColumn < 0 || reworkColumn < 0) {
		console.error("eval-ratings.csv 缺少 id/useful_1_5/rework 列，请重新生成");
		process.exit(1);
	}
	// Provenance matters: a predicted rating must never be mistaken for an observed one.
	let provenanceColumn = header.indexOf("rated_by");
	if (!spec) {
		console.log("（待评分清单，写入时可用 --rated-by 标注来源）\n");
	} else if (provenanceColumn < 0) {
		provenanceColumn = header.length;
		header.push("rated_by");
		for (const row of rows.slice(1)) row.push("");
	}

	let results: ResultRecord[] = [];
	try {
		results = await readResults(dir);
	} catch {
		// Context is a convenience only; rating still works with the CSV alone.
	}
	const context = new Map(results.map((record) => [record.id, record]));
	const byId = new Map(rows.slice(1).filter((row) => row[idColumn]).map((row) => [row[idColumn]!, row]));

	if (!spec) {
		const pending = [...byId.values()].filter((row) => !(row[usefulColumn] ?? "").trim());
		console.log(`待评分 ${pending.length}/${byId.size} 条。按下面的顺序给出评分即可：\n`);
		for (const row of pending) {
			const record = context.get(row[idColumn]!);
			const where = record
				? `${record.modelRef}/${record.thinkingLevel ?? "-"} · 复杂度${record.complexity ?? "?"} · 置信度${record.confidence?.toFixed(2) ?? "?"} · 描述充分${record.sufficient === false ? "否" : "是"}`
				: "";
			console.log(`${row[idColumn]}`);
			console.log(`  ${(row[1] ?? "").slice(0, 70)}`);
			console.log(`  ${where}\n`);
		}
		console.log('写入示例：npx tsx scripts/eval.ts --rate "qa-1=5,0; docs-1=4,1"');
		console.log("格式：id=可用性(1-5),返工(0/1)  分号分隔；未列出的条目保持原值。");
		console.log("来源标记：npx tsx scripts/eval.ts --rate --rated-by human \"qa-1=5,0\"（默认 human；预测请用 agent-prediction）");
		return;
	}

	const applied: string[] = [];
	const unknown: string[] = [];
	for (const entry of spec.split(";")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [id, value] = trimmed.split("=");
		const row = id ? byId.get(id.trim()) : undefined;
		if (!id || !row) {
			unknown.push(trimmed);
			continue;
		}
		const [usefulText, reworkText] = (value ?? "").split(",");
		const useful = Number((usefulText ?? "").trim());
		if (!Number.isInteger(useful) || useful < 1 || useful > 5) {
			console.error(`${id}: 可用性必须是 1–5 的整数（收到 ${JSON.stringify(usefulText ?? "")}）`);
			process.exit(1);
		}
		const rework = (reworkText ?? "").trim().toLowerCase();
		row[usefulColumn] = String(useful);
		row[reworkColumn] = rework === "1" || rework === "y" || rework === "yes" || rework === "true" ? "true" : "false";
		row[provenanceColumn] = provenance;
		applied.push(id.trim());
	}

	if (applied.length === 0) {
		console.error(`没有可写入的条目${unknown.length > 0 ? `（未知 id：${unknown.join(", ")}）` : ""}`);
		process.exit(1);
	}
	await writeFile(`${csvPath}.bak`, text);
	await writeFile(csvPath, `${rows.map((row) => row.map(csvField).join(",")).join("\n")}\n`);
	console.log(`已写入 ${applied.length} 条（rated_by=${provenance}）：${applied.join(", ")}`);
	if (unknown.length > 0) console.log(`忽略了未知 id：${unknown.join(", ")}`);
	console.log(`原文件备份为 ${csvPath}.bak；下一步 npx tsx scripts/eval.ts --report`);
}

if (process.argv.includes("--report")) {
	await report(OUT_DIR);
	process.exit(0);
}

const rateIndex = process.argv.indexOf("--rate");
if (rateIndex >= 0) {
	// The spec is the argument that contains "=": it cannot be confused with a flag.
	const spec = process.argv.slice(2).find((arg) => arg.includes("=") && !arg.startsWith("--"));
	const ratedByIndex = process.argv.indexOf("--rated-by");
	const ratedBy = ratedByIndex >= 0 ? (process.argv[ratedByIndex + 1] ?? "human") : "human";
	await rate(OUT_DIR, spec, ratedBy);
	process.exit(0);
}

function csvField(value: string | number | boolean | undefined): string {
	const text = value === undefined ? "" : String(value);
	return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function candidateSummary(config: RouterConfig, models: AnyModel[]): string[] {
	const refs = new Set(models.map((model) => `${model.provider}/${model.id}`));
	return config.candidates.map((candidate) => {
		const resolved = refs.has(candidate.modelRef);
		const model = resolved ? models.find((m) => `${m.provider}/${m.id}` === candidate.modelRef) : undefined;
		const vision = model?.input.includes("image") ? "视觉" : "纯文本";
		const types = candidate.taskTypes?.join("/") ?? "全部类型";
		return `${candidate.modelRef}${resolved ? "" : "（不在模型表中，永远不会被选中）"} · 成本${candidate.costTier}/能力${candidate.strengthTier} · ${vision} · ${types} · thinking=${candidate.thinkingLevel ?? "按复杂度推导"}`;
	});
}

const { config, issues } = await loadConfig(process.cwd(), homedir());
if (issues.length > 0) {
	console.log(`配置问题：\n  ${issues.join("\n  ")}`);
}

// Tasks the router would skip locally cannot be evaluated: analyzeTask would be called for
// a decision that is already determined, and the sample would not reflect real behaviour.
const SAMPLED = TASKS.filter((task) => hasRouteableCandidate(config, MODELS, task.hasImages));
const SKIPPED = TASKS.filter((task) => !hasRouteableCandidate(config, MODELS, task.hasImages));

console.log(`任务集：${TASKS.length} 条（带图 ${TASKS.filter((task) => task.hasImages).length} 条）`);
console.log("候选：");
for (const line of candidateSummary(config, MODELS)) console.log(`  ${line}`);
if (SKIPPED.length > 0) {
	console.log(`注意：${SKIPPED.length} 条任务没有任何可用候选，会被跳过、不计入样本：`);
	for (const task of SKIPPED) console.log(`  ${task.id}`);
}
console.log(`可评测样本：${SAMPLED.length} 条`);

if (!RUN) {
	console.log("\n未加 --run：仅打印计划，不发送请求。");
	console.log(`加上 --run 会发起 ${SAMPLED.length} 次 Jev 请求（可能计费），输出到 ${OUT_DIR}/`);
	process.exit(0);
}

if (SAMPLED.length === 0) {
	console.log("\n没有可评测样本：检查 candidates 是否指向可用模型。不发送任何请求。");
	process.exit(0);
}

console.log(`\n即将发起 ${SAMPLED.length} 次 Jev 请求，输出目录 ${OUT_DIR}`);
await mkdir(OUT_DIR, { recursive: true });

const records: string[] = [];
const ratingRows: string[] = [
	["id", "task", "model", "thinking", "complexity", "risk", "confidence", "sufficient", "useful_1_5", "rework"].join(","),
];
let failed = 0;

for (const task of SAMPLED) {
	const startedAt = Date.now();
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
		const elapsedMs = Date.now() - startedAt;
		records.push(
			JSON.stringify({
				id: task.id,
				covers: task.covers,
				task: task.text,
				hasImages: task.hasImages,
				analysis: result.analysis,
				confidence: result.confidence,
				recommended: { modelRef: decision.modelRef, label: decision.label, thinkingLevel: decision.thinkingLevel ?? null },
				fromJev: decision.fromJev,
				elapsedMs,
				usage: result.usage ?? null,
				failure: null,
			}),
		);
		ratingRows.push(
			[
				csvField(task.id),
				csvField(task.text),
				csvField(decision.modelRef),
				csvField(decision.thinkingLevel),
				csvField(result.analysis.complexity),
				csvField(result.analysis.risk),
				csvField(result.confidence.toFixed(2)),
				csvField(result.analysis.sufficient),
				"", // 人工：结果可用性 1–5
				"", // 人工：是否返工 true/false
			].join(","),
		);
		console.log(
			`${task.id}: ${result.analysis.taskType} · 复杂度${result.analysis.complexity} · 置信度${result.confidence.toFixed(2)} → ${decision.modelRef}/${decision.thinkingLevel ?? "-"} · ${elapsedMs}ms`,
		);
	} catch (error) {
		failed += 1;
		const failure = describeFailure(error, Date.now() - startedAt);
		records.push(
			JSON.stringify({
				id: task.id,
				covers: task.covers,
				task: task.text,
				hasImages: task.hasImages,
				analysis: null,
				confidence: null,
				recommended: null,
				fromJev: false,
				elapsedMs: failure.elapsedMs,
				usage: null,
				failure,
			}),
		);
		console.log(`${task.id}: 失败[${failure.category}${failure.status ? ` ${failure.status}` : ""}] ${failure.message}`);
	}
}

// 配置快照：只记录决策相关字段，凭证永远不写盘。
const snapshot = {
	generatedAt: new Date().toISOString(),
	candidates: config.candidates,
	fallbackModelRef: config.fallbackModelRef ?? null,
	jev: { baseUrl: config.jev.baseUrl, timeoutMs: config.jev.timeoutMs },
	models: MODELS.map((model) => ({
		ref: `${model.provider}/${model.id}`,
		reasoning: model.reasoning,
		input: model.input,
	})),
	tasks: SAMPLED.length,
	skipped: SKIPPED.map((task) => task.id),
	failed,
};

await writeFile(join(OUT_DIR, "eval-results.jsonl"), `${records.join("\n")}\n`);
await writeFile(join(OUT_DIR, "eval-ratings.csv"), `${ratingRows.join("\n")}\n`);
await writeFile(join(OUT_DIR, "eval-config.json"), `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`\n写入完成：${OUT_DIR}/eval-results.jsonl · eval-ratings.csv · eval-config.json`);
console.log(
	`失败 ${failed}/${SAMPLED.length}${SKIPPED.length > 0 ? `，跳过 ${SKIPPED.length} 条无候选任务` : ""}。人工填写 eval-ratings.csv 的 useful_1_5 与 rework 后再比较候选与档位。`,
);
