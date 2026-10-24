# 架构与接入边界

整体形态：**单桥接进程持唯一微信连接，内部挂 N 个后端适配器**。同一微信绑定只允许一个轮询进程，
这是采用单桥多后端（而非每平台一个进程）的决定性原因。

- `vendor/wechat-core`：上游 iLink 登录、长轮询、文本、加密附件传输。
- `src/backend.mjs`：`AgentBackend` 基类（每后端串行队列、审批命名空间、附件落盘）与两个适配器：
  - `CodexBackend`：Codex 官方 app-server 的本机 stdio JSONL 协议（`src/codex.mjs` 负责子进程、
    请求匹配、通知与服务器交互请求分发），复用已安装 Codex 的登录、模型与本机工具配置。
  - `ZcodeBackend`：一期用 headless CLI（`zcode -p … --cwd … --json`），每条消息一次进程，
    `--json` 返回结构化 `sessionId`/`response`，会话续接用 `--resume <sess_id>`；无流式回传与审批转发。
- `src/bridge.mjs`：路由器。绑定用户检查、持久化入站任务、`@前缀`/`/use` 路由、按后端分域的会话簿记、
  审批编号解析（`c1` → codex 后端）、逐后端 `/status`、结果回传（`[平台]` 前缀）。
- `src/storage.mjs`：schemaVersion 2（会话按后端分域）严格加载、v1→v2 自动迁移（先备份）、原子顺序写入、单进程锁。
- `src/cli.mjs`：`agents` 配置 schema 与旧单后端配置兼容、后端装配、扫码、凭据与通道生命周期。
- `run.ps1`：Windows 可直接执行的启动入口及构建检查。

## 并发与状态

模型回合不阻塞微信入站轮询；审批和取消命令直接处理，所以执行中的任务仍能收到手机回复。
**每后端一条串行队列（后端内一次一个任务），后端之间并行**；并行写冲突的主要防线是配置层强制
不同后端 workspace 分离（除非显式 `allowSharedWorkspace: true`，此时 `/status` 常驻提示风险）。
输出按回复上限分段，按发送顺序串行发往微信；多后端回传交错属预期，各自带 `[平台]` 前缀。
取消支持正在执行的 turn/进程、准备附件阶段，以及排队消息（`/cancel [后端]` 可按后端收敛）。

审批按后端独立命名空间：每后端自己的计数器，编号形如 `c1`（codex）/ `z1`（zcode），后端 id 首字母
必须互不相同（配置校验）。命令执行审批显示请求的命令和工作目录；文件修改审批附带变更路径和 diff。
用户回答工具支持问题ID逐一回答。不支持的其他服务器交互请求明确拒绝并提示，不能静默批准。
ZCode 一期 `yolo` 模式没有审批通道（等于预授权放行），这是产品边界不是 bug。

上游微信轮询原本先提交游标再调用宿主，无法保证本桥接持久化入站队列。
本地补丁改为所有消息成功入队后提交游标，失败时保留旧游标并退避；对应确定性测试覆盖顺序及磁盘失败。

## 协议与验证边界

本机版本 schema 与在线文档可能有差异。当前验证过的线程 sandbox 参数使用
`workspace-write` / `danger-full-access`；不要直接套用 turn 层 sandboxPolicy 的 camelCase type。
兼容性验证入口为 `doctor`（多后端握手/登录/路径发现）和 `smoke`（真实新建会话及命令执行）。

ZCode app-server 协议（`zcode.cjs app-server`）存在但不是 Codex 兼容协议，方法面无公开文档；
二期若需审批转发与常驻会话，需先逆向协议（桌面端与该 server 的实际交互流是最可靠样本）。
详见 [02-plan/multi-backend-plan.md](02-plan/multi-backend-plan.md) §5.3。

可后续扩展：更多后端适配器、ZCode app-server 接入、自动文件发送工具、后台服务、
已有桌面会话选择、更多交互请求与语音处理。这些不是当前已实现能力。
