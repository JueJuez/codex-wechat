# codex-wechat

通过微信指挥本机 Codex：读写文件、执行命令、修改代码，并把结果回传手机。
基于 [dsh-wechat](https://github.com/xcisxc29/dsh-wechat) 的 MIT 微信协议层，重写 Codex 宿主适配。
这是独立本机桥接程序，不需要安装 DSH。

流程：手机微信 → 腾讯 iLink → 本机桥接 → Codex app-server → 结果回传微信。
本机主动向外连接，无需公网 IP 或开放入站端口。

## 当前状态

第一版实现已完成；本机真实 Codex 命令执行和文件读写已通过验证。
微信文字任务执行与回传、手机审批、取消任务、`/send` 文件回传均已打通；入站附件仍需联调。
详细验证记录见 [docs/VALIDATION.md](docs/VALIDATION.md)。

已立项未实现：多后端跨平台路由（一个微信号同时指挥 Codex、ZCode 等多个本机 agent，
回传带平台标识，详见 [docs/02-plan/multi-backend-plan.md](docs/02-plan/multi-backend-plan.md)）。
当前代码仍是单 Codex 后端。

## Windows 启动

前提：Node.js 22.19+，已安装并登录 Codex CLI，手机微信支持 ClawBot/iLink。
本机已检测到可运行的 Codex，继续使用现有登录与模型配置，不需要另填 API Key。

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

配置可复制 [config.example.json](config.example.json) 为 `config.json`。按需要修改 `workspace` 和 `codexPath`。
不设置 model 时使用本机 Codex 的默认模型。`codexPath` 可填写 codex.exe 的完整路径。

## 微信用法

直接发送任务，例如“帮我查看这个项目的测试为什么失败，修好并报告结果”。
首次自动创建会话，后续消息持续使用同一会话；执行中收到的新任务排队。

| 命令 | 作用 |
|---|---|
| `/new 修复登录` | 创建新会话 |
| `/list` | 查看本桥接创建的会话 |
| `/switch 2` | 按列表序号切换 |
| `/current` | 查看当前会话 |
| `/status` | 查看运行、排队和审批状态 |
| `/cancel` | 取消运行任务并清空排队消息 |
| `/approve 1` / `/deny 1` | 同意一次或拒绝指定审批 |
| `/answer 1 question_id 回答` | 回答指定问题；多问题需逐一回答 |
| `/send outputs/result.txt` | 发送工作目录内文件到微信 |
| `/help` | 查看命令 |

手机发来的文件会保存到工作目录 `.codex-wechat/inbox/`，路径传给 Codex；图片作为本机图片输入。
语音优先使用微信服务提供的转写；没有转写时只能保存原文件，目前不保证语音识别。
文件回传由 `/send` 显式触发；模型仅告知生成路径，不会假装附件已发送。
切换或新建前需完成或取消当前及排队任务。

## 权限与状态

默认 `permissionMode: "workspace"`：使用 Codex `workspace-write` 沙箱和 `on-request` 审批策略。
普通工作区命令不必每次确认，Codex 发出的越界等审批请求转到微信。
若确实需要全电脑访问，显式配置 `permissionMode: "full"` 后重启：
Codex 将使用 `danger-full-access` + `never`，以当前 Windows 用户权限执行，不再请求执行审批。
工作区沙箱主要约束写入与执行，不代表绝对禁止读取工作区之外的文件。
`/send` 在两种模式下都限制在工作目录内，包括解析后的链接目标；最大 100MB。

本桥接只接收扫码绑定的 userId，拒绝其他发送者和群消息。
状态默认放在用户目录 `.codex-wechat/<工作目录哈希>/`，与项目源码分离，含微信凭据、游标、会话映射和待处理消息。
`doctor` 显示实际位置。可用 `stateDir` 配置覆盖；不要提交该目录或分享 state.json。
Windows 文件保护依赖用户目录 ACL；POSIX 同时使用 0600 文件模式。
同一状态目录只允许运行一个桥接或登录进程；不要与其他客户端同时轮询同一绑定。
首次绑定其他客户端已使用的微信账号可能影响既有绑定，请使用当前打算连接的账号。

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
