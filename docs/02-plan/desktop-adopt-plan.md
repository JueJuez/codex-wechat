# 增量计划：桌面会话接管（微信操作桌面 Agent）

日期：2026-10-25。状态：代码完成 + 单测全绿（42 项），真机验证待做。

## 1. 背景与目标

连接微信的核心价值是远程操作桌面端 Agent。此前断层：桌面端布置的任务会话不在桥的簿记里，
任务完成通知（旁路出站）不产生任何会话状态，微信回复接不上桌面上下文。
目标：桌面任务完成后微信通知（附会话 id）→ 微信一条 `/adopt` 接管 → 后续消息直接续接桌面会话。

## 2. 探针结论（2026-10-25 实测，4 项）

1. 桌面会话与 headless 会话**同库**：`~/.zcode/cli/db/db.sqlite` 的 `session` 表，`task_type` 均为 `interactive`。
2. headless `--resume sess_xxx` 续接 headless 会话：成功（同 sessionId、上下文延续）。
3. `--resume session_<hex>`（桌面 id）**能解析到会话**（报错非 "Session not found"），但 turn 失败："Select a model before sending a message"。
4. 根因：桌面会话模型绑定 `account:zai-start-plan`（登录套餐 provider），headless 默认解析 `new-provider/deepseek-v4.1-flash`；
   resume 沿用会话自带模型选择，`account:` provider 在 headless 不可解析。CLI 无 `--model` 参数、无 env 覆盖。

**接管前提**：桌面端把模型切到与 headless 共享的 provider（new-provider，如 deepseek-v4.1-flash）后新开的会话。
zai 套餐已过期（2026-10-25）；headless 侧 deepseek provider 正常可用，全部验证不耗套餐额度。

## 3. 落点（已完成，c255c88）

1. **`/adopt [引擎[/项目]] 会话id`**（`src/bridge.mjs`）：域解析同 `/switch`；将该域 current 指针绑到指定会话，
   不存在则建 `adopted:true` 条目（重复 adopt 幂等）；有排队任务时拒绝；`/list` 可见、`/switch` 可切回。
2. **`scripts/notify.mjs`**：桌面任务里执行 `node scripts/notify.mjs "任务完成：XX"`。
   `node:sqlite` 只读会话库按 cwd 归一化匹配最近活跃 interactive 会话；config.projects 按 workspace 反查项目；
   vendor `sendText` 发通知，附现成 `/adopt 命令`；`--session` 显式覆盖、`--engine` 默认 zcode、`--dry` 只打印（已实测）。
3. 内联新会话语法（2026-10-24，b01c29e）：`@引擎 [项目] /new 任务` 强制新开会话，`/new` 可在项目名前；无任务降级为就地新建（用 @ 的引擎）。

## 4. 验收标准

- [x] 内联 `/new`：新会话执行、后续消息续新会话、无任务降级新建、任务正文中 `/new` 不误判（单测）。
- [x] `/adopt`：绑定后消息 `--resume` 被接管会话、幂等不重复建条目（单测）。
- [ ] 桌面端切共享 provider 后：headless `--resume` 桌面会话探针通过（待测）。
- [ ] `notify.mjs` 真机发送：手机收到通知且 `/adopt` 命令可直接回复生效（待测）。
- [ ] `/adopt` 端到端：微信续接桌面会话上下文正确回忆（待测）。

## 5. 边界（不变）

桥不写 ZCode 会话库（notify 只读）；接管后模型选择沿用会话自带（provider 不一致会在任务时报错，不静默降级）；
codex 侧桌面线程接管未探针（codex thread 体系独立，后续需要时单独验证）；桥与运行中桌面 TUI 仍无法注入，接管只对"会话持久化后的续接"生效。
