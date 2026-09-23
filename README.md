# pi-jev-router

Pi 扩展：用 **Jev**（TypeSafe System One 决策模型）判断新会话首个任务的特征，自动路由到合适的模型与推理强度。

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
| `auto` | 首条任务自动判断并切换 |
| `shadow` | 只展示推荐，不切换（用于验证路由质量） |
| `locked` | 完全不干预，保留当前模型 |

## 配置

配置文件（后者覆盖前者，均可选）：

1. `~/.pi/agent/pi-jev-router.json`（全局）
2. `<项目>/.pi/pi-jev-router.json`（项目级）

参考 `router.config.example.json`。字段说明：

- `candidates[].modelRef`：`provider/model-id`，必须存在于 pi 的模型目录中。
- `costTier` 1–5：越小越便宜，能力满足时优先选便宜的。
- `strengthTier` 1–5：基础能力档位；推理强度（thinkingLevel）会在其上加成。
- `thinkingLevel`：该候选被选中时使用的推理强度（可选）。
- `taskTypes`：限定该候选适用的任务类型（可选）。
- `jev.apiKeyEnv`：存放 TypeSafe API key 的环境变量名。

## 使用

```bash
# 直接测试
pi -e /Users/darwish/Dev/pi-jev-router/src/index.ts

# 或安装为全局扩展（自动发现 + /reload 热更新）
ln -s /Users/darwish/Dev/pi-jev-router ~/.pi/agent/extensions/pi-jev-router
# 目录形式自动发现要求入口为 index.ts，见下方说明
ln -s src/index.ts /Users/darwish/Dev/pi-jev-router/index.ts
```

命令：

- `/route` 或 `/route status`：查看当前模式与最近决策。
- `/route auto` / `/route lock` / `/route shadow`：切换模式（持久化到会话）。

状态栏显示：`route: <model>/<thinking>`。

## 开发

```bash
npm install
npm run typecheck        # 类型检查
npx tsx src/router.test.ts   # 纯路由逻辑冒烟测试
```

## 已知边界

- 只在**会话首条用户消息**路由一次；后续消息不自动重新路由（可用 `/route` 手动查看/改模式）。
- 路由期间用户手动切换模型会被尊重（不覆盖）。
- `scopedModels`（`--models` / `enabledModels`）非空时，只在其范围内选择。
- 扩展以完整系统权限运行，配置只从上述受信任位置读取。
