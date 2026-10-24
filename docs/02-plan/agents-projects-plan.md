# 二期计划：引擎（agents）× 项目（projects）正交拆分

Owner：仓库所有者
状态：生效（代码完成，2026-10-24；40 项单测全绿，桥接已停待用户通知重启后真机联调，见 VALIDATION.md）
创建：2026-10-24
前置：[multi-backend-plan.md](multi-backend-plan.md)（一期，已完成）

## 1. 背景与目标

一期把「后端」定义为引擎 + 工作目录的绑死条目（`agents.codex.workspace = …`）。用户实际心智模型是两个正交维度：
**引擎**（派谁去干：codex / zcode）× **项目**（在哪干：wx / brain / …）。
二期把两个维度拆开注册，任意引擎可操作任意项目，无需为每个组合复制配置。

## 2. 已确认的决策

| 决策点 | 结论 | 否决项 |
|---|---|---|
| 寻址语法 | `@引擎 [项目] 任务` 两段式；第二段命中项目 id 则消费为项目，否则整句为任务 | `@引擎#项目`（手机打 # 麻烦）；纯 `/project` 切换 + 裸消息（会话状态易迷失） |
| 同项目并发 | 任何时刻一个项目只有一个任务在改（跨引擎也串行），不同项目并行 | 允许同项目并行（写冲突风险自负） |
| 队列粒度 | 引擎内串行（一期语义不变）+ 项目互斥锁叠加 | 每（引擎，项目）对独立队列（CodexClient/进程实例翻倍，复杂度不值） |

## 3. 改造落点（已完成）

1. **配置层 `src/cli.mjs`**：`agents` 只描述引擎参数（不再含 workspace）；新增 `projects` 注册表（id 校验同引擎正则，workspace 必填）。兼容两级旧配置：一期 agents 带 workspace → 自动拆出同名项目；单后端顶层配置 → 单 codex 引擎 + 同名项目。`defaultProject` 缺省取第一个项目。stateDir 仍按默认项目 workspace 哈希推导，默认项目路径不变 → 微信绑定与 state.json 不丢。
2. **适配器层 `src/backend.mjs`**：workspace 从构造参数改为按任务传参。会话簿记键从引擎 id 改为复合键 `引擎/项目`（`pairKey`）；session 记录携带 `project`。Codex 的 `thread/start|resume` cwd、ZCode 的 spawn `--cwd`/`cwd`、附件 inbox 目录均取任务所属项目。
3. **互斥锁 `bridge.mjs` `lockProject`**：每项目一条 promise 锁链，`acquired` 在前持有者 release 后才 resolve 出本次的 release；单任务单锁、无嵌套持锁。`AgentBackend.execute` 通过 Bridge 注入的 `acquireProject` 在任务全程持锁。
4. **路由 `bridge.mjs`**：`@引擎 [项目] 任务`；裸消息 → `defaultAgent × 当前项目`。新增 `/project 项目`；`/switch [引擎[/项目]] 序号` 支持域前缀；`/list` `/current` `/status` 按 引擎×项目 展示；`/send` 用当前项目 workspace。
5. **状态迁移 `src/storage.mjs`**：`SCHEMA_VERSION = 3`。v1→v2→v3 链式迁移：v2 的纯引擎键 → `引擎/引擎` 复合键，jobs 补 `project`。迁移前备份。
6. **doctor**：逐引擎检查 + 逐项目 workspace 存在性检查。

## 4. 验收标准

- [x] `@引擎 项目 任务` 路由到正确 workspace；第二段非项目名不误判（单测）。
- [x] 同项目跨引擎串行、不同项目并行（单测，gate 文件控制时序）。
- [x] 旧 config（两种旧形态）与 v1/v2 state.json 自动迁移（单测，含备份文件断言）。
- [x] `npm test` 全绿（40 项）。
- [ ] 微信真机：`@zcode brain …` 与 `@codex wx …` 各自正确路由（待联调）。
- [ ] 微信真机：同项目两引擎任务串行回传顺序正确（待联调）。

## 5. 边界（不变）

微信单连接单进程；ZCode yolo 无审批转发；桌面端 ZCode 会话不可控；app-server 协议逆向仍搁置。
