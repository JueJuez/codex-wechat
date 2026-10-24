# codex-wechat

通过微信指挥本机多个 agent 后端（Codex、ZCode）：读写文件、执行命令、修改代码，并把结果回传手机，回传带平台标识。
基于 [dsh-wechat](https://github.com/xcisxc29/dsh-wechat) 的 MIT 微信协议层，重写 agent 宿主适配。
这是独立本机桥接程序，不需要安装 DSH。

流程：手机微信 → 腾讯 iLink → 本机桥接 → Codex app-server / ZCode headless CLI → 结果回传微信。
本机主动向外连接，无需公网 IP 或开放入站端口。

## 当前状态

多后端一期已完成并通过真机验证；二期「引擎 × 项目」正交拆分已完成代码与单测（40 项全绿）：
agents（引擎）与 projects（项目目录）分注册，`@引擎 [项目] 任务` 两段式路由，同项目跨引擎串行。
一期能力：一个微信号同时指挥 Codex 与 ZCode，`[平台]` 回传标识、按引擎命名的审批编号（`/approve c1`）、逐引擎 `/status`。
Codex 真实命令执行与文件读写、ZCode headless 两轮会话续接（`--resume`）、微信真机两后端并行联调
（含停机期间消息补收）均已验证，记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。
尚未真机验证：二期 `@引擎 项目` 路由与跨引擎同项目串行、附件发到多后端、`/approve c1` 真机操作、`/cancel zcode` 中途取消。

## Windows 启动

前提：Node.js 22.19+；已登录 Codex CLI（或有效 `executable` 路径）；使用 ZCode 后端需先 `zcode login`；
手机微信支持 ClawBot/iLink。

在本目录 PowerShell 中执行：

```powershell
.\run.ps1 doctor
.\run.ps1 login
.\run.ps1 start
```

首次启动会安装依赖并构建。`login` 显示二维码，手机扫描并确认后保存绑定；
`start` 持续接收指令，电脑必须开机且进程保持运行。Ctrl+C 停止。
启动脚本只为当前进程补齐 Windows 环境变量，不修改系统配置。

日常使用可以后台运行，不必保持终端窗口：

```powershell
.\run.ps1 background
.\run.ps1 status
.\run.ps1 stop
```

后台启动会等待真实进程就绪才报告成功。停止是给该桥接进程发本地停止请求，不按进程名称批量结束其他 Codex。
日志在状态目录 runtime.out.log / runtime.err.log / bridge.log，不记录消息正文和凭据。

也可用标准 Node/npm 流程：

```powershell
npm ci --ignore-scripts
npm run build
npm run doctor
npm run login
npm start
```

## 配置

复制 [config.example.json](config.example.json) 为 `config.json` 后按需修改。
配置分两个正交维度：**agents**（引擎：codex / zcode，只写引擎参数）与 **projects**（项目：id → workspace 目录）。
任意引擎可操作任意项目；**同一项目同一时刻只有一个任务在改**（跨引擎也串行），不同项目之间并行。

关键约束：**不同项目的 `workspace` 必须指向不同目录**（不同项目并行执行，共享目录会写冲突）；
确要共享必须显式设置 `"allowSharedWorkspace": true`，此时 `/status` 会常驻提示风险。

- `codex` 引擎：`executable` 可省略或填 `"codex"`，桥接会按「显式路径 → `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 最新版 → PATH」自动发现（ChatGPT 桌面版捆绑目录随升级漂移）。
- `zcode` 引擎：`cli` 填 zcode.cjs 绝对路径（桌面版捆绑为 `D:/AI/ZCode/resources/glm/zcode.cjs`）；使用前先 `zcode login`。`mode` 默认 `yolo`（全自动），**没有中途审批通道，等于预授权放行**，务必让它的项目 workspace 独立、可抛弃。
- 一期写法（agents 条目自带 workspace）仍可运行：自动按「每引擎一个同名项目」拆分，启动时有迁移提示。
- 更早的单后端配置（顶层 `workspace`/`codexPath`/`permissionMode`/`model`）不改一行仍可运行：等价于单 codex 引擎 + 同名项目。
- `defaultAgent` / `defaultProject` 是无前缀任务的默认引擎与项目。

## 微信用法

直接发送任务（交给默认引擎 × 当前项目），或用 `@引擎 [项目]` 指定：

```
@codex brain 调研一下 XX 库的缓存设计，写个对比文档
@zcode wx 修复登录页测试失败，修完报告
[zcode] 已收到，zcode → brain 开始处理。   ← 回执带引擎与项目
[zcode] 任务完成：…                       ← 结果带引擎标识
```

`@` 后第二段若命中已注册项目 id（如 `brain`）则作为目标项目，否则整句为任务、发往当前项目。
首次自动创建会话，后续消息持续使用同一会话（按 引擎/项目 分域）；同一引擎内任务串行，
同一项目跨引擎也串行，不同项目之间并行，回传可能交错。

| 命令 | 作用 |
|---|---|
| `@zcode brain 任务` | 指定引擎（可选项目）执行 |
| `/use zcode` | 设置本会话默认引擎（重启后保持） |
| `/project brain` | 设置本会话默认项目（重启后保持） |
| `/new [项目] 标题` | 创建新会话（默认引擎） |
| `/list` | 会话列表（按 引擎/项目 分组） |
| `/switch [引擎[/项目]] 2` | 按列表序号切换，可带域 |
| `/current` | 当前引擎、项目与各域当前会话 |
| `/status` | 逐引擎：连接 / 运行 / 排队 / 审批；逐项目：占用与排队 |
| `/cancel [引擎]` | 取消任务并清空排队；不带参数作用于全部引擎 |
| `/approve c1` / `/deny c1` | 同意或拒绝指定审批（编号按引擎命名：c=codex，z=zcode） |
| `/answer c1 question_id 回答` | 回答指定问题；多问题需逐一回答 |
| `/send outputs/result.txt` | 发送当前项目工作目录内文件到微信 |
| `/help` | 查看命令 |

手机发来的文件会保存到目标后端工作目录 `.codex-wechat/inbox/`，路径随任务传入；图片作为本机图片输入（ZCode 以附件形式 `--attach`）。
语音优先使用微信服务提供的转写；没有转写时只能保存原文件，目前不保证语音识别。
文件回传由 `/send` 显式触发；模型仅告知生成路径，不会假装附件已发送。
切换或新建前需完成或取消该后端的当前及排队任务。

ZCode 后端一期边界：每条消息一次进程冷启动（秒级），无流式回传；`yolo` 模式无审批转发。

## 权限与状态

Codex 后端默认 `permissionMode: "workspace"`（按后端配置）：使用 `workspace-write` 沙箱和 `on-request` 审批策略。
普通工作区命令不必每次确认，Codex 发出的越界等审批请求转到微信，编号形如 `c1`。
若确实需要全电脑访问，配置 `permissionMode: "full"` 后重启：`danger-full-access` + `never`，不再请求执行审批。
工作区沙箱主要约束写入与执行，不代表绝对禁止读取工作区之外的文件。
`/send` 在两种模式下都限制在工作目录内，包括解析后的链接目标；最大 100MB。

ZCode 后端 `mode` 支持 `build/edit/plan/yolo/guarded`，但一期只有 `yolo` 可用（其他模式的中途审批无法转发微信，任务会卡住）。

本桥接只接收扫码绑定的 userId，拒绝其他发送者和群消息。
状态默认放在用户目录 `.codex-wechat/<默认后端工作目录哈希>/`，与项目源码分离，含微信凭据、游标、会话映射和待处理消息。
`doctor` 显示实际位置。可用 `stateDir` 配置覆盖；不要提交该目录或分享 state.json。
Windows 文件保护依赖用户目录 ACL；POSIX 同时使用 0600 文件模式。
同一状态目录只允许运行一个桥接或登录进程；不要与其他客户端同时轮询同一绑定。
首次绑定其他客户端已使用的微信账号可能影响既有绑定，请使用当前打算连接的账号。

状态文件 `schemaVersion: 3`：会话按「引擎/项目」复合键分域（`sessions["codex/wx"]`）。
旧版 v1/v2 状态首次启动自动迁移（v2 的纯引擎键映射为 `引擎/引擎`），迁移前在状态目录留 `state.json.bak-<时间戳>` 备份。

接受消息时先持久化入站队列，再推进微信游标；有 messageId 的消息去重。
重启后等待中的任务继续排队，已开始但中断的任务报告“结果未知”，不会自动重跑命令。
无法发送的文字保存在状态目录 `undelivered/`，不自动重复发送，也不重跑原任务。
这不是事务性的恰好一次执行；极端崩溃或没有 messageId 的消息仍有重复或未知结果边界。

## 开发与边界

```powershell
.\run.ps1 check
.\run.ps1 smoke  # 真实调用一次模型，在临时目录验证文件读写
```

它执行本机 Codex 任务；不实现实时屏幕视频、任意软件鼠标操作或接管桌面端当前聊天。
桌面应用的专属插件与工具不保证出现在独立 app-server 会话中。
支持前台及后台进程运行，尚未安装 Windows 服务或设置开机自启。

实现细节及来源见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 和 [vendor/wechat-core/UPSTREAM.md](vendor/wechat-core/UPSTREAM.md)。
多后端架构决策与 ZCode app-server 协议（二期）见 [docs/02-plan/multi-backend-plan.md](docs/02-plan/multi-backend-plan.md)。
