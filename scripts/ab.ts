/**
 * A/B 对照实验：判断“某类任务能不能从中档降到低档”。
 *
 * 为什么需要它：`scripts/eval.ts` 每条任务只在一个档位上跑过，跨任务平均无法比较档位。
 * 只有把**同一条任务**在两个档位上各做一次，看“能否一次完成”，才能回答降档问题。
 *
 * 默认只打印计划，不执行、不花钱；加 --run 才会真的调用模型，每个任务 × 每档一次。
 * 每次运行都在独立的 detached worktree 里进行（不在主分支上改代码），跑完默认清理。
 *
 * 用法：
 *   npx tsx scripts/ab.ts                                   # 打印计划
 *   npx tsx scripts/ab.ts --run                             # 执行（内置 2 条任务 × 2 档）
 *   npx tsx scripts/ab.ts --run --tasks ab-tasks.json --low cc-switch-kimi/kimi-k2.7-code:high --high openai-codex/gpt-5.6-sol:high
 *   npx tsx scripts/ab.ts --run --keep                      # 保留 worktree 供人工看 diff
 *
 * 判定：低档“检查通过 + 改动合理”的比例与高档相当 → 可以降档；明显更差 → 保持现档位。
 * 注意：检查通过只是必要条件，任务是否真的做完仍需人工看 diff（结果文件留了 review 列）。
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

interface AbTask {
	id: string;
	/** 任务文本，必须能在这个仓库里自证完成（例如靠 npm run typecheck 与测试）。 */
	prompt: string;
	/** 额外的验证命令（在 worktree 里执行，退出码 0 视为通过）。 */
	extraChecks?: string[];
}

const DEFAULT_TASKS: AbTask[] = [
	{
		id: "explain-reason",
		prompt:
			"在 src/router.ts 中新增并导出一个纯函数 describeAnalysis(analysis: JevTaskAnalysis): string，" +
			"返回一句中文摘要（包含任务类型、复杂度、风险、是否需要视觉），并在 decideRoute 生成 reason 时复用它，" +
			"保证 src/router.test.ts 的既有断言全部通过。不要修改测试断言。",
	},
	{
		id: "report-cost",
		prompt:
			"给 scripts/eval.ts 的 --report 输出增加“该分组候选的平均 costTier”一列（从 eval-config.json 的 candidates 读取），" +
			"保持其他列与整体输出的既有格式不变，并确保 npx tsx scripts/eval.ts --report 仍然能正常运行。",
	},
];

const ARGS = process.argv.slice(2);
const RUN = ARGS.includes("--run");
const KEEP = ARGS.includes("--keep");
const valueOf = (flag: string, fallback: string): string => {
	const index = ARGS.indexOf(flag);
	const value = index >= 0 ? ARGS[index + 1] : undefined;
	return value && !value.startsWith("--") ? value : fallback;
};
const LOW = valueOf("--low", "cc-switch-kimi/kimi-k2.7-code:high");
const HIGH = valueOf("--high", "openai-codex/gpt-5.6-sol:high");
const TIMEOUT_SECONDS = Number(valueOf("--timeout", "300"));
const TASKS_FILE = valueOf("--tasks", "");
const REPO_ROOT = resolve(process.cwd());
const OUT_DIR = resolve(REPO_ROOT, valueOf("--out", "ab-out"));

const TASKS: AbTask[] = TASKS_FILE
	? (JSON.parse(await readFile(TASKS_FILE, "utf8")) as AbTask[])
	: DEFAULT_TASKS;
const TIERS: Array<{ name: "low" | "high"; ref: string }> = [
	{ name: "low", ref: LOW },
	{ name: "high", ref: HIGH },
];

/** 仓库自身的检查；两条都必须在 worktree 里通过才算“一次完成”。 */
const BASE_CHECKS = [
	"npm run typecheck",
	"npx tsx src/router.test.ts",
	"npx tsx src/config.test.ts",
	"npx tsx src/credentials.test.ts",
	"npx tsx src/jev.test.ts",
	"node --experimental-strip-types src/index.test.ts",
];

interface CheckResult {
	command: string;
	ok: boolean;
	detail: string;
}

interface AbRun {
	task: string;
	tier: string;
	model: string;
	worktree: string;
	exitCode: number | null;
	timedOut: boolean;
	durationMs: number;
	changedFiles: number;
	changedLines: number;
	checks: CheckResult[];
	ok: boolean;
	/** 人工填写：任务是否真的做完、是否返工。 */
	review: string;
}

function runCommand(
	command: string,
	options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; durationMs: number }> {
	return new Promise((resolvePromise) => {
		const startedAt = Date.now();
		const child = spawn(command, {
			cwd: options.cwd,
			shell: true,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const timer =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
						setTimeout(() => child.kill("SIGKILL"), 5_000);
					}, options.timeoutMs);
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			resolvePromise({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt });
		});
	});
}

/** `provider/model:thinking` → pi 的 `--model` 与 `--thinking` 参数。 */
function parseTier(ref: string): { model: string; thinking?: string } {
	const [, afterProvider] = ref.split("/");
	const [modelId, thinking] = (afterProvider ?? "").split(":");
	const provider = ref.split("/")[0];
	return { model: `${provider}/${modelId}`, ...(thinking && { thinking }) };
}

if (!RUN) {
	console.log(`仓库：${REPO_ROOT}`);
	console.log(`输出：${OUT_DIR}/ab-results.jsonl（+ sessions/ 与 worktree/）`);
	console.log(`任务：${TASKS.length} 条 · 档位：low=${LOW} high=${HIGH}`);
	console.log(`计划运行：${TASKS.length * TIERS.length} 次（每次最多 ${TIMEOUT_SECONDS}s）`);
	for (const task of TASKS) console.log(`  ${task.id}: ${task.prompt.slice(0, 70)}…`);
	console.log(`\n每个 worktree 内会执行：${BASE_CHECKS.join(" · ")}`);
	console.log("\n未加 --run：仅打印计划，不调用模型。");
	console.log("提示：这会在 detached worktree 里跑真实编码任务，消耗真实 token；主分支不受影响。");
	process.exit(0);
}

await mkdir(join(OUT_DIR, "worktree"), { recursive: true });
await mkdir(join(OUT_DIR, "sessions"), { recursive: true });
console.log(`准备在 ${OUT_DIR}/worktree 下跑 ${TASKS.length * TIERS.length} 次，单次上限 ${TIMEOUT_SECONDS}s\n`);

const results: AbRun[] = [];

for (const task of TASKS) {
	for (const tier of TIERS) {
		const name = `${task.id}-${tier.name}`;
		const worktreePath = join(OUT_DIR, "worktree", name);
		const { model, thinking } = parseTier(tier.ref);
		console.log(`—— ${name}（${model}${thinking ? ` thinking=${thinking}` : ""}）`);

		await rm(worktreePath, { recursive: true, force: true });
		const added = await runCommand(`git worktree add --detach "${worktreePath}" HEAD`, { cwd: REPO_ROOT });
		if (added.code !== 0) {
			console.error(`  git worktree add 失败：${added.stderr.trim().slice(0, 200)}`);
			continue;
		}
		// 直接复用主 checkout 的依赖，避免每个 worktree 再装一次。
		const modules = join(REPO_ROOT, "node_modules");
		if (existsSync(modules)) await symlink(modules, join(worktreePath, "node_modules")).catch(() => {});

		const thinkingFlag = thinking ? ` --thinking ${thinking}` : "";
		const prompt = `--model ${model}${thinkingFlag} -p ${JSON.stringify(task.prompt)}`;
		// --no-extensions: measure the model, not the router (this extension would otherwise
		// route the first task and switch models mid-experiment).
		// --approve: non-interactive runs do not prompt; be explicit about project resources.
		const piRun = await runCommand(
			`pi --no-extensions --approve --session-dir ${JSON.stringify(join(OUT_DIR, "sessions"))} ${prompt}`,
			{ cwd: worktreePath, timeoutMs: TIMEOUT_SECONDS * 1000 },
		);

		const status = await runCommand("git status --porcelain", { cwd: worktreePath });
		const diffStat = await runCommand("git diff --stat HEAD", { cwd: worktreePath });
		// `git add -N` makes new files show up in the diff, so the patch is the whole change set.
		// The node_modules symlink this script created is excluded: it is not the agent's work.
		await runCommand("git add -A -N", { cwd: worktreePath });
		const patch = await runCommand('git diff HEAD -- . ":(exclude)node_modules"', { cwd: worktreePath });
		await mkdir(join(OUT_DIR, "diffs"), { recursive: true });
		await writeFile(join(OUT_DIR, "diffs", `${name}.patch`), patch.stdout.slice(0, 400_000));
		const changedFiles = status.stdout.split("\n").filter((line) => line.trim().length > 0).length;
		const changedLines = (diffStat.stdout.match(/(\d+) insertions?/)?.[1] ?? "0")
			? Number(diffStat.stdout.match(/(\d+) insertions?/)?.[1])
			: 0;

		const checks: CheckResult[] = [];
		for (const command of [...BASE_CHECKS, ...(task.extraChecks ?? [])]) {
			const check = await runCommand(command, { cwd: worktreePath, timeoutMs: 180_000 });
			checks.push({
				command,
				ok: check.code === 0,
				detail: check.code === 0 ? "ok" : (check.stdout + check.stderr).trim().split("\n").slice(-3).join(" / ").slice(0, 300),
			});
		}
		const ok = piRun.code === 0 && !piRun.timedOut && checks.every((check) => check.ok);
		results.push({
			task: task.id,
			tier: tier.name,
			model,
			worktree: worktreePath,
			exitCode: piRun.code,
			timedOut: piRun.timedOut,
			durationMs: piRun.durationMs,
			changedFiles,
			changedLines,
			checks,
			ok,
			review: "",
		});
		const failed = checks.filter((check) => !check.ok).map((check) => check.command);
		console.log(
			`   pi exit=${piRun.code}${piRun.timedOut ? "(超时)" : ""} ${Math.round(piRun.durationMs / 1000)}s · ` +
				`文件 ${changedFiles} · 行 +${changedLines} · 检查 ${ok ? "通过" : `失败(${failed.join(",")})`}`,
		);
		if (piRun.code !== 0) {
			console.log(`   pi 输出尾部：${(piRun.stdout + piRun.stderr).trim().split("\n").slice(-3).join(" / ").slice(0, 300)}`);
		}

		if (!KEEP) {
			await runCommand(`git worktree remove --force "${worktreePath}"`, { cwd: REPO_ROOT });
		}
	}
}

await writeFile(join(OUT_DIR, "ab-results.jsonl"), `${results.map((run) => JSON.stringify(run)).join("\n")}\n`);

console.log("\n任务            低档(完成/检查)   高档(完成/检查)  低档改动  高档改动");
for (const task of TASKS) {
	const low = results.find((run) => run.task === task.id && run.tier === "low");
	const high = results.find((run) => run.task === task.id && run.tier === "high");
	const mark = (run?: AbRun) =>
		`${run === undefined ? "未跑" : run.exitCode === 0 && !run.timedOut ? "完成" : "未完成"}/${run === undefined ? "-" : run.checks.every((check) => check.ok) ? "通过" : "失败"}`;
	console.log(
		`${task.id.padEnd(16)} ${mark(low).padEnd(18)} ${mark(high).padEnd(16)} ` +
			`${String(low?.changedLines ?? "-").padStart(8)} ${String(high?.changedLines ?? "-").padStart(9)}`,
	);
}
console.log(`\n写入 ${join(OUT_DIR, "ab-results.jsonl")}`);
console.log(`每个 run 的完整改动：${join(OUT_DIR, "diffs")}/<task>-<tier>.patch`);
console.log("人工必做：逐条看低档的 diff（对比高档 patch），填 review 列后再下“能否降档”的结论。");
console.log("“检查通过”只说明没把仓库弄坏，不说明任务真的做完了。");
