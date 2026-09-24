# pi-jev-router

Pi 扩展：用 **Jev**（TypeSafe System One 决策模型）判断新会话首个任务的特征，自动路由到合适的模型与推理强度。

## 安装与更新

```bash
# 方式 1：npm（发布后 API 索引有几分钟延迟）
pi install npm:@darwish-yu/pi-jev-router

# 方式 2：Git（立即可用）
pi install git:github.com/LonelyFellas/pi-jev-router

# 更新 / 查看 / 卸载
pi update
pi list
```

本地开发不走安装，用符号链接即可（见下方“新用户首次设置”）。

## 原理

```
首条用户任务
  → Jev 并行判断（任务类型 / 复杂度 / 风险 / 描述是否充分）
  → 程序按候选能力表匹配（能力满足要求里最便宜的）
  → 切换模型 + 推理强度 → 原任务继续执行
```

- Jev 只做结构化判断（Choice / Score / Noul），不生成文本。
- 模型能力（视觉、推理、成本档位）由配置维护，不依赖 Jev 的模型知识。
- Jev 不可用 / 超时 / 无匹配候选 → 回退到当前模型，不阻塞任务。

## 模式

| 模式 | 行为 |
|---|---|
| `auto` | 首条任务自动判断并切换；若分析认定描述不充分（`sufficient=false`），则保留当前模型与推理强度，只把推荐显示在状态栏 |
| `shadow` | 只展示推荐，不切换（用于验证路由质量） |
| `locked` | 完全不干预，保留当前模型 |

## 新用户首次设置

以下命令在本仓库根目录运行。**不要把真实 key 发到聊天、写进 JSON 或提交到 Git。**

1. 安装依赖；仅在尚无全局配置时复制示例，并将 `candidates[].modelRef` 改成自己在 pi 中可用的模型。示例模式为 `shadow`（只建议、不切换）；需要自动切换时将 `mode` 改为 `auto`：

   ```bash
   npm install
   mkdir -p "$HOME/.pi/agent"
   cp -n router.config.example.json "$HOME/.pi/agent/pi-jev-router.json"
   ```

2. 在自己的终端隐藏输入 key，仅供当前终端及从这里启动的 pi 使用（不会写入命令历史）：

   ```bash
   printf 'TypeSafe API key: '
   IFS= read -r -s TYPESAFE_API_KEY
   printf '\n'
   export TYPESAFE_API_KEY
   ```

   示例配置中的 `jev.apiKey` 已指向 `$TYPESAFE_API_KEY`。若要持久使用，且接受 key **明文存于 `~/.zshrc`**，可在安装了全局 `typesafe-ai-key` skill 后由本人在终端运行：

   ```bash
   bash "$HOME/.pi/agent/skills/typesafe-ai-key/scripts/configure-typesafe-key.sh" TYPESAFE_API_KEY "$HOME/.zshrc"
   ```

   之后重启终端，并从该终端重启 pi。macOS 也可在「钥匙串访问」中新建密码项（服务/名称 `pi-jev-router`，账户 `typesafe`，密码为 key），再把配置中的 `jev.apiKey` 改为 `"!/usr/bin/security find-generic-password -s pi-jev-router -a typesafe -w"`；此方式无需环境变量，首次读取可能弹出钥匙串授权。

3. 按下方“使用”启动 pi。`/route status` 只报告凭证来源或环境变量是否存在，**不验证 key 有效性**；钥匙串命令来源会显示为已配置但尚未解析。新开会话后发送首条非敏感任务，再用 `/route status` 查看“来源：Jev”。可选运行 `npx tsx scripts/smoke.ts` 做端到端检查，但它会发出四次 Jev API 请求，可能计费。

## 配置

配置文件（后者覆盖前者，均可选）：

1. `~/.pi/agent/pi-jev-router.json`（全局）
2. `<项目>/.pi/pi-jev-router.json`（项目级）

参考 `router.config.example.json`。字段说明：

- `candidates[].modelRef`：`provider/model-id`，必须存在于 pi 的模型目录中。
- `costTier` 1–5：越小越便宜，能力满足时优先选便宜的。
- `strengthTier` 1–5：基础能力档位；推理强度（thinkingLevel）会在其上加成。
- `thinkingLevel`：该候选被选中时使用的推理强度（可选），可选 `off`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`；`off` 表示固定不思考。该值是**固定 pin**：未 pin 时才按复杂度推导，pin 优先于推导（复杂度不会抬升已 pin 的候选——见下方“档位对照实验”的回退说明）。模型不支持的等级由 pi 收敛，实际生效值会显示在状态栏与 `/route status`。
- `taskTypes`：限定该候选适用的任务类型（可选）。
- `jev.apiKey`：凭证来源（推荐）。支持 `$ENV`、`${ENV}`、`!command`；不要把真实 key 提交到配置或聊天中。macOS 可用 `!/usr/bin/security find-generic-password -s pi-jev-router -a typesafe -w`。
- `insufficientPolicy`：分析器判为描述不充分时的行为。`advisory`（默认）保留当前模型，只展示建议；`route` 仍然切换。
- `minConfidence`：低于该置信度同样只建议（0–1，默认 `0` 即关闭）。用现有 20 条数据算过：低置信度组的预测返工率反而**低于**其余组（<0.5 组 0% vs 其余 28%，<0.6 组 0% vs 33%），说明置信度在这批样本上不预示返工，所以默认不开启。
- `jev.apiKeyEnv`：兼容字段，存放 TypeSafe API key 的环境变量名，默认 `TYPESAFE_API_KEY`；未设置 `jev.apiKey` 时生效。

安全：项目级 `.pi/pi-jev-router.json` 只在项目被信任后读取；`!command` 是可信本地配置，只在 Jev 请求时执行，带超时、输出上限和最小化环境，报错会抹掉凭证。缺少凭证时会回退到当前模型；仅有一个可用模型时不会发起 Jev 分析。

## 使用

在仓库根目录运行：

```bash
# 直接测试
pi -e "$PWD/src/index.ts"

# 或安装为全局扩展（自动发现 + /reload 热更新）
mkdir -p "$HOME/.pi/agent/extensions"
ln -s "$PWD" "$HOME/.pi/agent/extensions/pi-jev-router"
```

仓库根目录已包含 `index.ts` 入口，无需再创建链接；安装或修改扩展代码后运行 `/reload` 或重启 pi。

命令：

- `/route` 或 `/route status`：查看当前模式、最近决策、是否因用户改模型而保留（`用户覆盖`）、分析依据（taskType / 描述是否充分 / 置信度）以及上次失败类别与耗时。
- `/route auto` / `/route lock` / `/route shadow`：切换模式（持久化到会话）。

状态栏区分推荐与实际：`route(shadow): <model>/<thinking>` 只是建议（shadow 模式不生效）；`route: <model>/<thinking>` 是实际生效的模型与推理强度；两者不一致时（切换失败、用户改模型、描述不充分）显示 `route: <实际> (建议 <推荐>)`。

模型切换与推理强度分开执行：即使推荐的模型就是当前模型，推荐推理强度仍会应用（例如当前 low、复杂任务推荐同模型 xhigh 时，会调整为 xhigh）。

## 开发

```bash
npm install
npm run typecheck                 # 类型检查
npx tsx src/router.test.ts        # 纯路由逻辑测试
npx tsx src/config.test.ts        # 配置校验与分层合并测试（不读盘）
npx tsx src/credentials.test.ts   # 凭证来源本地测试（不触网）
npx tsx src/jev.test.ts           # 取消语义、失败分类、响应校验测试（stub fetch，不触网）
node --experimental-strip-types src/index.test.ts   # 会话/路由/覆盖行为测试（不触网）
npx tsx scripts/eval.ts           # 打印评测计划（不联网）
npx tsx scripts/eval.ts --run     # 评测并写盘（20 次 API 请求，可能计费）
npx tsx scripts/eval.ts --rate    # 打印待评分清单
npx tsx scripts/eval.ts --report  # 汇总质量列与分析器开销
npx tsx scripts/ab.ts             # 打印档位对照计划（不调用模型）
npx tsx scripts/ab.ts --run       # 同任务×两档的真实对照（会调模型、在 detached worktree 里跑）
npx tsx scripts/smoke.ts          # Jev + 路由端到端冒烟（四次 API 请求）
```

## 评测（成本与质量依据）

`strengthTier`/`costTier`/`capabilityOf` 的加成表和 `THINKING_BY_COMPLEXITY` 都是手工常数，仓库本身无法证明它们更省钱或质量足够。要调参就得先有数据，流程是：

1. `npx tsx scripts/eval.ts` 检查任务集、候选解析和是否有任务根本没候选（这类任务会被真正跳过，不发请求也不计入样本）。
2. `npx tsx scripts/eval.ts --run` 正式跑，在 `eval-out/` 生成：
   - `eval-results.jsonl`：每条任务的 `analysis/complexity/risk/confidence/sufficient`、推荐模型与 thinking、Jev 耗时与用量、失败分类。
   - `eval-ratings.csv`：只有机器列被填，`useful_1_5`（结果可用性）与 `rework`（是否返工）留空给人工填。
   - `eval-config.json`：当次候选、模型表与任务数快照（不含凭证）。
3. `npx tsx scripts/eval.ts --rate` 看待评分清单，用 `--rate "id=可用性1-5,返工0/1"` 写回（自动备份 `.bak`）。如果是预测而非实测，加 `--rated-by agent-prediction`，报告会把它标出来。
4. `npx tsx scripts/eval.ts --report` 看按模型/等级汇总的质量列与 Jev 开销。

**这个评测能回答什么、不能回答什么**：它只能校准“分析器 + 路由策略”的输入（复杂度/风险/confidence/sufficient 是否可靠），**不能比较模型档位**——每条任务只在一个档位上跑过，档位间任务难度不同，平均可用性自然不可比（实际跑出来便宜档的平均分反而最高）。要判断“某档能不能抬下来”，必须拿**同一批任务在两个档位上各跑一次**（要真的执行任务，不是只调 Jev）。

因此人工列的意义是发现“明显不行”的条目，而不是给档位排序。

### 档位对照实验（判断能否降低候选档位）

想验证“某类任务能不能从中档降下来”（例如把 `complexity 4 / risk 4–5` 的任务从最贵档换成中档），跨任务评分证明不了，只能做同任务对照：

1. 选 4–6 条边界任务（复杂度 4+、或分析器判为描述不充分的），任务文本从 `eval-out/eval-ratings.csv` 取。
2. 每条任务在**临时 worktree** 里各跑两次：一次用低档（如 `kimi/high`）、一次用高档（如 `sol/high`）。不要在主线跑，这些任务会改代码。
3. 只看两个客观指标：能否一次完成、是否需要返工（不需要打 1–5 分）。
4. 判定：低档返工率与高档相当 → 可以降档（历史数据上 `costTier` 均值从 2.20 降到 1.80）；低档明显更高 → 保持现档位。

`scripts/eval.ts` 只能调 Jev 分析器，不会执行任务；同任务对照用 `scripts/ab.ts`：它把每条任务在 detached worktree 里用两个档位各跑一次，记录退出码、改动量、仓库检查（typecheck + 5 个测试）是否通过，并把完整 patch 写到 `ab-out/diffs/`。默认只打印计划，`--run` 才真的调模型；`--low`/`--high` 指定档位（如 `cc-switch-kimi/kimi-k2.7-code:high`），`--keep` 保留 worktree。

跑完必须人工看两侧 patch 再填 `review`：**检查通过只说明没弄坏仓库，不代表任务真的做完**。

### 两轮 A/B 对照的完整证据与回退决定

第一轮（3 条 c4 任务）低档 `kimi/high` 全部完成，曾据此把 `thinkingLevel` 改为“下限”（让复杂度把中档抬到 `high` 处理 c4）。第二轮（同 3 条再跑一轮）暴露了问题：低档在 c4 上**连续 2 次超时（代码正确）、1 次未完成集成**（建了模块却没接进 `/route status`）；高档 6/6 全部完整完成，还主动把新测试加进了 CI workflow。

**两轮合计低档 6 次运行只完整完成 3 次**，方向一致，不值得用坏默认值换成本。因此回退：`thinkingLevel` 恢复为**固定 pin**，c4 仍落在最贵档。这次流程的成本是几次真实调用，收益是没有把一个坏默认发出去。证据（结果与 patch）在本地 `ab-out/`。

## 已知边界

- 只在**会话首条用户消息**路由一次；后续消息不自动重新路由（可用 `/route` 手动查看/改模式）。
- 路由期间用户手动切换模型会被尊重（不覆盖）；`/model` 与 Ctrl+P 轮换都算手动干预，会话恢复时的模型选择不算。
- 首条任务在 Jev 分析期间被取消（`ctx.signal` 已中止）：不发 Jev 请求、不切模型，也不消耗“只路由一次”的机会，下一条消息仍会路由。
- `scopedModels`（`--models` / `enabledModels`）非空时，只在其范围内选择。
- 没有可路由候选时（未配置候选、候选都缺模型、带图任务但候选均不支持图片）不发 Jev 请求，直接用回退模型；`taskTypes` 依赖分析结果，不进本地预筛。
- 配置错误不会被静默忽略：加载时逐字段校验，非法条目被丢弃、未知字段（`candidate` 这类拼写错误）会被点名，均在会话开始时提示一次；Jev 响应中的非有限数值会归类为 `invalid-response` 而不是变成 NaN。
- 分析器认为描述不充分（`sufficient=false`）时不切换模型、也不改推理强度，只给建议（可用 `insufficientPolicy: "route"` 恢复切换）：在描述不清的首条消息上换模型（还附带一次 prompt cache 失效）不划算。
- 失败信息只保留分类、HTTP 状态码与耗时，不保留响应正文：正文可能回显、截断或掩码化凭证，而它会写进 session 并被 `/route status` 展示。
- 扩展以完整系统权限运行，配置只从上述受信任位置读取。
