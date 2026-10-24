# 多后端跨平台桥接开发计划

Owner：仓库所有者
状态：生效（一期完成，2026-10-24；全部验收项已验证，见 VALIDATION.md；二期「引擎×项目」拆分见 [agents-projects-plan.md](agents-projects-plan.md)，一期 agents 带 workspace 的写法已转为兼容读取）
创建：2026-10-24
说明：本文是给下一个实现会话的交接文档，包含架构决策、本机实测事实、改造点清单与验收标准。实现时以文中「怎么做」为准；与本文件冲突的旧描述以本文件为准。

实施记录（2026-10-24）：一期已按 §6 顺序完成，`src/backend.mjs` 落地 `AgentBackend` 基类 + Codex/ZCode 适配器。
偏离计划的两点：① ZCode 适配器实测发现 `--json` 旗标（headless 返回结构化 `sessionId`/`response`），采用它替代解析终端正文（纯文本解析留作兜底）；② 会话分域为每条会话补了稳定 `ref` 键（v1 迁移时 ref=id），`conv.current` 按后端存 ref。§9 待定项按建议取值：默认后端 codex、zcode 一期 yolo、workspace 由用户在 config.json 填不同目录。已验证：33 项单测全绿、真实 v1 state.json 副本迁移、doctor 多后端检查（codex 路径自动发现命中真实哈希目录）、ZCode 真实两轮 `--resume` 端到端。

## 1. 背景与目标

现状是微信 ↔ 单个 Codex 的一对一桥接。目标改为：**一个微信入口指挥多个本机 agent 后端（Codex、ZCode，未来可扩展其他 CLI 类 agent），各后端并行干活、完成后回报，回传能分清是哪个平台；用户发指令能指定交给哪个平台。**

典型用法：

```
@codex 修复登录页测试失败，修完报告
@zcode 调研一下 XX 库的缓存设计，写个对比文档
/status            → 汇总所有后端运行/排队状态
[zcode] 任务完成：…（回传带平台标签）
```

非目标（本计划不做）：实时屏幕操作、接管桌面端聊天、跨机器分布式调度、语音识别保证。

## 2. 架构决策：单桥多后端

**一个桥接进程持有唯一微信连接，内部挂 N 个后端适配器。**

决定性约束（README「权限与状态」已声明）：同一微信绑定只允许一个轮询进程，两个进程轮询同一绑定会互相干扰。因此「每个平台各跑一个桥接进程」不可行，微信连接只能有一个主人。

备选方案否决记录（保留决策上下文）：

| 方案 | 结论 | 原因 |
|---|---|---|
| 多桥接进程各连微信 | 否决 | 违反微信单轮询约束 |
| hub + spokes 多进程（薄微信网关 + 各平台独立 worker 进程 IPC） | 暂缓 | 崩溃隔离和跨机器扩展更好，但 IPC 层属过度设计；单进程内适配器已满足需求，留二期以后评估 |
| 单进程多后端适配器 | **采用** | 改造量最小，复用现有 Bridge/Storage/生命周期 |

## 3. 现状快照（改造点定位）

一对一硬绑定分布在五处，改造时逐处核对：

1. `src/cli.mjs` `loadConfig`：config 只有单 `codexPath`，无后端注册表。
2. `src/cli.mjs` `start`：只 spawn 一个 `CodexClient`，注入 Bridge。
3. `src/bridge.mjs`：`work()` 是全局单任务队列（一次只跑一个任务）；`this.counter` 审批编号全局递增；`/status` 文案写死「Codex」；`conversations[].sessions` 不分后端。
4. `src/codex.mjs`：`CodexClient` 直接耦合 Codex 协议（thread/turn 方法名、通知、审批请求）。
5. 状态目录与 `state.json`：结构假设单后端（sessions 列表、jobs 无后端维度）。

## 4. 目标设计

### 4.1 后端适配器接口

从 `CodexClient` + `Bridge.run` 的协作面抽象统一接口（`src/backend.mjs` 新文件）：

```text
AgentBackend（每个后端实现）:
  id            'codex' / 'zcode'（路由与审批命名空间用，不可变）
  label         回传前缀显示名
  connected     存活状态
  ensureThread(conv)     会话不存在时创建；返回 thread/session 标识
  resumeThread(conv)     恢复已有会话（幂等）
  sendTurn(text, files)  发起一轮任务，返回可 await 的完成结果
  interrupt()            中断当前轮
  事件: completed / failed / approval(message) / disconnect
```

- Codex 适配器：现有 `CodexClient` + `bridge.run` 内的 thread/turn 调用整体平移进去，行为不变。
- ZCode 适配器（一期）：见 §5.2，spawn headless CLI，`sendTurn` 即一次进程执行。
- Bridge 退化为路由器：维护 `Map<id, AgentBackend>`，把微信消息按路由规则派发给某个后端的队列。

### 4.2 路由（分清在使唤谁）

- 消息以 `@<id> ` 开头 → 路由到该后端，剩余文本作为任务内容；未知 id 回提示并列出可用后端。
- `/use <id>`：设置该微信会话的默认后端（持久化到 conversation）。
- 无前缀 → 默认后端（config `defaultAgent`，缺省 `codex`）。
- 控制命令（`/list` `/status` 等）本身不路由，但命令参数可带后端维度（见 4.5）。

### 4.3 回传标识（分清谁在汇报）

- 所有回传文本统一加前缀 `[codex] ` / `[zcode] `（`reply()` 内做，一处改动全局生效）。
- 审批编号按后端独立命名空间：每后端自己的计数器，编号形如 `c1`、`z2`；`/approve z2` 先解析前缀字母找后端再找编号。`this.counter` 全局计数器废弃。
- `/status` 改为逐后端汇总：每个后端一行（连接状态 / 运行中任务 / 排队数 / 审批待办）。
- 「已收到，开始处理」回执同样带前缀，让用户立刻知道任务派给了谁。

### 4.4 并发模型

- 每后端一条串行队列（后端内一次一个任务，沿用现有语义）；后端之间并行。`work()` 从单循环改为每后端一个 pump。
- **强制 workspace 分离**：config 校验不同后端不得指向同一 workspace（除非显式配置 `allowSharedWorkspace: true` 并在 /status 提示冲突风险）。这是并行写冲突的主要防线。

### 4.5 会话与状态

- `conversations[].sessions` 改为按后端分域：`{ codex: [...], zcode: [...] }`；`/list` 输出按后端分组；`/switch` 语法 `/switch codex 2`。
- `state.json` 加 `schemaVersion` 字段；启动时做迁移：现有 sessions/jobs 归入 `codex` 域（他们全部由 Codex 产生）。迁移前备份 `state.json.bak-<日期>`。
- 入站附件目录 `.codex-wechat/inbox/` 建在**目标后端的 workspace** 下（现在写死单一 config.workspace）。

### 4.6 配置 schema（目标形态）

```json
{
  "defaultAgent": "codex",
  "maxReplyChars": 3000,
  "agents": {
    "codex": {
      "adapter": "codex-app-server",
      "executable": "C:/Users/O1830/AppData/Local/OpenAI/Codex/bin/a96ca4c1eee0cf35/codex.exe",
      "workspace": "D:/Code/project/A",
      "permissionMode": "workspace",
      "model": null
    },
    "zcode": {
      "adapter": "zcode-headless",
      "node": "node",
      "cli": "D:/AI/ZCode/resources/glm/zcode.cjs",
      "workspace": "D:/Code/project/B",
      "mode": "yolo",
      "locale": "zh-CN"
    }
  }
}
```

旧 `workspace`/`codexPath` 单后端配置做兼容读取：等价于只配一个 codex 后端（迁移期 warning 提示）。

## 5. 平台接入要点（本机实测 2026-10-24，实现前重验）

### 5.1 Codex 后端

- 协议：现有 `codex app-server` stdio JSONL，代码已验证可用，零新工作。
- ⚠ `codex` **不在 PATH**（`where codex` 失败）。实际位置：
  `C:\Users\O1830\AppData\Local\OpenAI\Codex\bin\a96ca4c1eee0cf35\codex.exe`
  （ChatGPT 桌面版捆绑，哈希目录随版本更新漂移。doctor 应实现发现逻辑：优先 config 显式路径 → `$LOCALAPPDATA/OpenAI/Codex/bin/*/codex.exe` 取最新 → PATH。）
- 登录态 `~/.codex/auth.json` 存在。

### 5.2 ZCode 后端（一期用 headless CLI）

- 入口：`node D:\AI\ZCode\resources\glm\zcode.cjs`（版本 0.17.0，桌面版捆绑）。
- headless 用法（--help 已核实的旗标）：
  `zcode -p "<任务文本>" --cwd <workspace> --resume <sess_id> --attach <文件> --mode yolo --locale zh-CN`
- 会话连续性：首次执行后从输出解析 `sess_...` 会话 id 存入 conversation，后续消息带 `--resume`。
- 认证：`zcode login`（zai/bigmodel 浏览器授权），与桌面版共享凭据；实现前先跑一次 `zcode doctor` 确认。
- 已知限制（必须写进 /help 或 README）：
  - `--mode yolo` 全自动，**中途审批请求无法转发微信**（等于预授权放行）；缓解：给 zcode 配独立、可抛弃的 workspace。
  - 每条消息一次进程冷启动（秒级），无流式回传。
  - stdout 是给人看的终端文本，完成报告需截取正文段落，解析要留容错。

### 5.3 ZCode app-server 协议（二期，先记录事实）

- 存在 `zcode.cjs app-server`：stdio JSON-RPC，收到非法方法返回标准 `-32601`。
- **不是 Codex 兼容协议**：实测 `initialize` / `listSessions` / `rpc.discover` / `ping` 全部 Method not found。
- 协议方法面无公开文档；bundle 内可见 `createSession` / `interruptRun` 等内部函数名但非协议方法名，需要系统逆向（建议方法：strace 通信流——桌面端 app 与该 server 的实际交互是最可靠的协议样本；或联系官方要文档）。
- 收益：审批转发到微信 + 常驻会话无冷启动。协议逆向成功前不承诺。

## 6. 实施顺序（一期）

按依赖序，每步可独立验证：

1. `src/backend.mjs` 定义接口 + Codex 适配器平移（不引入路由，行为等价重构）→ 跑通现有 smoke。
2. 配置层：`agents` schema + 旧配置兼容 + doctor 后端发现（含 codex 路径 glob）。
3. 路由器改造：Bridge → 多后端派发、`@` 前缀、`/use`、回传前缀、审批命名空间、`/status` 汇总。
4. 并发改造：每后端队列，jobs/active/approvals 全部按后端键控；`/cancel` 支持指定后端（`/cancel zcode`）或全部。
5. 状态迁移：schemaVersion + conversations 分域迁移 + 备份。
6. ZCode headless 适配器 + 微信端到端联调（真机扫码跑一条 `@zcode` 任务）。
7. 文档同步：README 用法表、ARCHITECTURE、本计划标「生效」并勾验收。

## 7. 验收标准（一期）

- [x] `@codex 任务` 与 `@zcode 任务` 各自执行并回传，回传首字符可区分平台。（单测 + 微信真机验证 2026-10-24）
- [x] 两后端同时各跑一个任务（可用「sleep 型」任务验证并行）。（单测覆盖：codex turn 未完成时 zcode 进程已启动；真机两任务并行入队）
- [x] `/status` 一次列出所有后端状态；`/use` 切默认后端并重启后保持。（单测覆盖逻辑与持久化）
- [x] codex 审批流不回归：`/approve c1` 只作用于 codex 的审批。
- [x] 旧 state.json 启动自动迁移，旧 Codex 会话可 `/list` 可 `/switch codex n`。（真实 v1 副本迁移验证）
- [x] 旧版单后端 config.json 不改一行也能跑（兼容）。（doctor 实测）
- [x] doctor 能发现 codex.exe 实际路径（PATH 缺失场景）并报告 zcode 可用性。（doctor 实测）

## 8. 风险与边界

- **并行写冲突**：靠 workspace 强制分离（4.4）+ config 校验兜底；共享目录必须显式opt-in。
- **ZCode yolo 无审批闸门**：文档明示 + 建议独立 workspace；这是一期产品边界不是 bug。
- **捆绑路径漂移**：ChatGPT 桌面版/ZCode 桌面版升级都会挪哈希目录；doctor 的发现逻辑是第一道防线，发现失败给出可操作的指引而不是裸报错。
- **回传顺序**：多后端并行后微信回传交错属预期（各自带前缀）；同一后端内仍严格串行。
- 微信单连接约束不变：整个系统仍然只有一个桥接进程持微信号。

## 9. 待定决策（实现会话开始前找用户确认）

1. 两个后端各自 workspace 指向哪个目录（建议不同项目目录，见 4.4）。
2. 默认后端设 codex 还是 zcode。
3. zcode 一期 `--mode` 用 yolo（全自动）还是 build/edit（保守但会卡住等审批，一期没有转发通道，不建议）。

## 10. 附：本机实测命令记录（2026-10-24）

```text
zcode --help                        → 0.17.0，重验 -p/--cwd/--resume/--attach/--mode/--locale 全部在
zcode -p "…" --json --mode yolo     → 结构化输出：{ sessionId, response, usage, projection.status }，
                                      适配器据此以 --json 为主（偏离 §5.2 的终端文本解析，文本解析留兜底）
codex.exe 实际位置                    → %LOCALAPPDATA%\OpenAI\Codex\bin\a96ca4c1eee0cf35\codex.exe（重验在）
~/.codex/auth.json                   → 存在（登录态在）
ZcodeBackend 真实两轮                 → 首轮解析 sess_ id，二轮 --resume 后正确回忆首轮信息
微信真机联调                          → @codex 约 1s 回传，@zcode 冷启动约 28s 回传，并行、前缀均符合预期
```

（2026-10-11 初版实测记录已并入上文，原始条目：`printf initialize | zcode app-server → -32601`、
`listSessions/rpc.discover/ping → -32601`，协议存在但不兼容 Codex，仍为二期前置事实。）
