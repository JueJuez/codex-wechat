import { readFile, mkdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import { login, ChannelMonitor, sendText, downloadItemMedia } from '../vendor/wechat-core/lib/index.js';
import { sendFilePath } from './wechat-file.mjs';
import { Storage, acquireLock } from './storage.mjs';
import { CodexClient } from './codex.mjs';
import { CodexBackend, ZcodeBackend, resolveCodexExecutable } from './backend.mjs';
import { Bridge } from './bridge.mjs';
import { runtimeStatus, launchBackground, requestStop, watchStop } from './lifecycle.mjs';

const ID_RE = /^[a-z][a-z0-9-]*$/;

function normalizeAgentBody(id, raw) {
  if (!raw || typeof raw !== 'object') throw new Error(`agents.${id} 必须是对象`);
  const agent = { ...raw };
  delete agent.workspace; // workspace 属于 projects，不留在引擎条目上
  if (agent.adapter === 'codex-app-server') {
    agent.permissionMode ??= 'workspace';
    if (!['workspace', 'full'].includes(agent.permissionMode)) throw new Error(`agents.${id}.permissionMode 只能是 workspace 或 full`);
    if (agent.model !== undefined && typeof agent.model !== 'string' && agent.model !== null) throw new Error(`agents.${id}.model 只能是字符串或 null`);
    agent.model ??= null;
    if (typeof agent.executable !== 'undefined' && typeof agent.executable !== 'string') throw new Error(`agents.${id}.executable 无效`);
    agent.executable ??= 'codex';
  } else if (agent.adapter === 'zcode-headless') {
    if (!agent.cli || typeof agent.cli !== 'string') throw new Error(`agents.${id}.cli 必填（zcode.cjs 绝对路径）`);
    agent.node ??= 'node';
    agent.mode ??= 'yolo';
    if (!['build', 'edit', 'plan', 'yolo', 'guarded'].includes(agent.mode)) throw new Error(`agents.${id}.mode 只能是 build/edit/plan/yolo/guarded`);
    agent.locale ??= 'zh-CN';
  } else throw new Error(`agents.${id}.adapter 未知：${agent.adapter}（支持 codex-app-server、zcode-headless）`);
  return agent;
}

// 引擎（agents）与项目（projects）正交：agent 只描述引擎参数，workspace 全部挂在 projects 上。
// 兼容两种旧形态：① agents 条目自带 workspace（一期多后端）→ 每条目拆出同名项目；
// ② 无 agents 的单后端配置 → 单 codex 引擎 + 单项目。
function normalizeRegistries(custom) {
  if (custom.agents === undefined) {
    const codexPath = custom.codexPath ?? 'codex';
    if (typeof codexPath !== 'string' || !codexPath) throw new Error('codexPath 无效');
    if (custom.permissionMode !== undefined && !['workspace', 'full'].includes(custom.permissionMode)) throw new Error('permissionMode 只能是 workspace 或 full');
    console.error('提示：检测到旧版单后端配置，已按单一 codex 引擎 + 同名项目读取；建议迁移到 agents + projects 结构（参考 config.example.json）。');
    return {
      agents: { codex: { adapter: 'codex-app-server', executable: codexPath, permissionMode: custom.permissionMode ?? 'workspace', model: custom.model ?? null } },
      projects: { codex: { workspace: custom.workspace || process.cwd() } }
    };
  }
  if (!custom.agents || typeof custom.agents !== 'object' || Array.isArray(custom.agents) || !Object.keys(custom.agents).length) throw new Error('agents 必须是非空对象');
  const agents = {};
  const legacyWorkspaces = {};
  let legacy = false;
  for (const [id, raw] of Object.entries(custom.agents)) {
    if (!ID_RE.test(id)) throw new Error(`引擎 id 无效（小写字母开头，可含数字/-）：${id}`);
    if (raw && typeof raw === 'object' && raw.workspace !== undefined) {
      if (typeof raw.workspace !== 'string' || !raw.workspace) throw new Error(`agents.${id}.workspace 必须是非空字符串`);
      legacyWorkspaces[id] = raw.workspace; legacy = true;
    }
    agents[id] = normalizeAgentBody(id, raw);
  }
  let projects;
  if (custom.projects !== undefined) {
    if (!custom.projects || typeof custom.projects !== 'object' || Array.isArray(custom.projects) || !Object.keys(custom.projects).length) throw new Error('projects 必须是非空对象');
    if (legacy) console.error('提示：agents 条目内的 workspace 字段已忽略（项目目录以 projects 为准）；建议从 agents 中删除 workspace。');
    projects = {};
    for (const [id, raw] of Object.entries(custom.projects)) {
      if (!ID_RE.test(id)) throw new Error(`项目 id 无效（小写字母开头，可含数字/-）：${id}`);
      if (!raw || typeof raw !== 'object' || !raw.workspace || typeof raw.workspace !== 'string') throw new Error(`projects.${id}.workspace 必填`);
      projects[id] = { workspace: raw.workspace };
    }
  } else {
    if (!legacy) throw new Error('projects 未定义且 agents 未携带 workspace：请在 config 增加 projects 节（项目 id → workspace），或回退一期写法（agents 条目自带 workspace）');
    console.error('提示：检测到一期写法（agents 条目自带 workspace），已按「每引擎一个同名项目」拆分；建议迁移到 projects 结构（参考 config.example.json）。');
    projects = Object.fromEntries(Object.entries(legacyWorkspaces).map(([id, workspace]) => [id, { workspace }]));
  }
  return { agents, projects };
}

export async function loadConfig(file = resolve('config.json')) {
  let custom = {};
  try { custom = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const { agents, projects } = normalizeRegistries(custom);
  const config = { maxReplyChars: 3000, allowSharedWorkspace: false, ...custom, agents, projects };
  if (!Number.isInteger(config.maxReplyChars) || config.maxReplyChars < 100 || config.maxReplyChars > 4000) throw new Error('maxReplyChars 必须为 100–4000 的整数');
  const agentIds = Object.keys(agents);
  config.defaultAgent ||= agentIds.includes('codex') ? 'codex' : agentIds[0];
  if (!agents[config.defaultAgent]) throw new Error(`defaultAgent ${config.defaultAgent} 未在 agents 中定义`);
  const projectIds = Object.keys(projects);
  config.defaultProject ||= projectIds[0];
  if (!projects[config.defaultProject]) throw new Error(`defaultProject ${config.defaultProject} 未在 projects 中定义`);
  const letters = new Set();
  for (const id of agentIds) {
    if (letters.has(id[0])) throw new Error(`引擎 ${id} 与其他引擎 id 首字母重复，审批编号无法区分，请改名`);
    letters.add(id[0]);
  }
  for (const id of projectIds) projects[id].workspace = resolve(projects[id].workspace);
  const byWorkspace = new Map();
  for (const id of projectIds) {
    const workspace = projects[id].workspace;
    const prev = byWorkspace.get(workspace);
    if (prev) {
      if (!config.allowSharedWorkspace) throw new Error(`项目 ${prev} 与 ${id} 工作区相同（${workspace}）；不同项目并行执行会写冲突。请分离工作区，或显式设置 "allowSharedWorkspace": true`);
      config.sharedWorkspaceWarning = `项目 ${prev} 与 ${id} 共享工作区 ${workspace}，并行执行可能写冲突`;
    }
    byWorkspace.set(workspace, id);
  }
  const primary = projects[config.defaultProject].workspace;
  const workspaceKey = createHash('sha256').update(process.platform === 'win32' ? primary.toLowerCase() : primary).digest('hex').slice(0, 12);
  config.stateDir = resolve(custom.stateDir || join(homedir(), '.codex-wechat', workspaceKey));
  return config;
}

async function createBackends(config) {
  const backends = new Map();
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.adapter === 'codex-app-server') {
      const executable = await resolveCodexExecutable(agent.executable);
      backends.set(id, new CodexBackend({ id, permissionMode: agent.permissionMode, model: agent.model, executable }));
    } else {
      backends.set(id, new ZcodeBackend({ id, node: agent.node, cli: agent.cli, mode: agent.mode, locale: agent.locale }));
    }
  }
  return backends;
}

async function bind(store, config) {
  const signal = new AbortController();
  process.once('SIGINT', () => signal.abort());
  const generator = login({ existingTokens: store.data.account ? [store.data.account.token] : [], reuseExisting: 'adopt' }, signal.signal);
  let answer;
  while (true) {
    const step = await generator.next(answer); answer = undefined;
    if (step.done) {
      if (step.value.alreadyBound && store.data.account) { console.log('复用已有绑定。'); return; }
      if (!step.value.account) throw new Error(step.value.reason || '已有绑定但本机无凭据，请检查其他微信桥接程序');
      return;
    }
    const event = step.value;
    if (event.kind === 'qr') {
      const file = join(config.stateDir, 'login-qr.png');
      await QRCode.toFile(file, event.qrUrl);
      console.log(await QRCode.toString(event.qrUrl, { type: 'terminal', small: true }));
      console.log(`请用微信扫码并确认，二维码图片：${file}`);
    } else if (event.kind === 'verifycode-required') {
      const rl = createInterface({ input: stdin, output: stdout });
      try { answer = await rl.question('请输入手机验证码：'); } finally { rl.close(); }
    } else if (event.kind === 'confirmed') {
      if (!event.account.userId) throw new Error('微信未返回绑定用户，拒绝启用远程执行');
      // A new identity must not inherit a previous identity's conversations or credentials.
      if (store.data.account?.userId && store.data.account.userId !== event.account.userId) {
        throw new Error('绑定用户变化，请使用新的 stateDir，原状态已保留');
      }
      if (store.data.account?.accountId !== event.account.accountId) store.data.syncBuf = '';
      store.data.account = event.account; await store.save(); console.log('微信绑定成功。运行 npm start 开始接收任务。');
    } else if (event.kind === 'failed') throw new Error(event.reason);
    else if (event.kind === 'scanned') console.log('已扫码，请在微信确认。');
  }
}

async function doctor(config, store) {
  const lines = [];
  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.adapter === 'codex-app-server') {
      let executable;
      try { executable = await resolveCodexExecutable(agent.executable); }
      catch (e) { lines.push(`[${id}] codex 路径发现失败：${e.message}`); continue; }
      const client = new CodexClient({ executable });
      try {
        await client.initialize();
        const account = await client.call('account/read', {});
        lines.push(`[${id}] codex app-server：握手成功；登录：${account.account ? '已登录' : '未登录'}；程序：${executable}；权限 ${agent.permissionMode}`);
      } catch (e) { lines.push(`[${id}] codex app-server 握手失败（${executable}）：${e.message}`); }
      finally { client.close(); }
    } else {
      const cliExists = await stat(agent.cli).then(() => true, () => false);
      const nodeOk = spawnSync(agent.node, ['--version'], { timeout: 15000, windowsHide: true }).status === 0;
      lines.push(`[${id}] zcode headless：node ${nodeOk ? '可用' : '不可用'}；cli ${cliExists ? '存在' : '缺失'}（${agent.cli}）；模式 ${agent.mode}（无审批转发，建议项目工作区独立可抛弃）${cliExists ? '；请确认已 zcode login' : ''}`);
    }
  }
  for (const [id, project] of Object.entries(config.projects)) {
    const exists = await stat(project.workspace).then(s => s.isDirectory(), () => false);
    lines.push(`[项目 ${id}] ${exists ? '工作区存在' : '工作区缺失'}：${project.workspace}`);
  }
  lines.push(`微信：${store.data.account?.userId ? '已绑定' : '未绑定'}；默认引擎：${config.defaultAgent}；默认项目：${config.defaultProject}；状态目录：${config.stateDir}`);
  if (config.sharedWorkspaceWarning) lines.push(`⚠ ${config.sharedWorkspaceWarning}`);
  console.log(lines.join('\n'));
  console.log('此检查未调用模型，未访问微信。');
}

async function start(store, config) {
  if (!store.data.account?.userId) throw new Error('请先运行 npm run login 完成微信绑定');
  const account = store.data.account;
  const signal = new AbortController();
  const backends = await createBackends(config);
  const log = async message => {
    console.error(message);
    await appendFile(join(config.stateDir, 'bridge.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {});
  };
  try { await Promise.all([...backends.values()].map(b => b.init())); }
  catch (e) { for (const backend of backends.values()) backend.close(); throw e; }
  const bridge = new Bridge({
    backends, store, config, log,
    sendText: async (message, text) => {
      const contextToken = store.data.conversations[message.conversationId]?.contextToken || message.contextToken;
      try {
        await sendText({ account, to: message.peerId, text, contextToken });
        await log(`文字发送已接受，${Array.from(text).length} 字符`);
      }
      catch (e) {
        // Delivery may be uncertain: save the exact result locally, never rerun the task.
        const dir = join(config.stateDir, 'undelivered'); await mkdir(dir, { recursive: true });
        await writeFile(join(dir, `${Date.now()}-${Math.random().toString(16).slice(2)}.txt`), text, { mode: 0o600 });
        throw e;
      }
    },
    sendFile: async (message, file) => {
      await sendFilePath({ account, to: message.peerId, path: file, contextToken: store.data.conversations[message.conversationId]?.contextToken });
      await log('文件发送已接受');
    },
    downloadMedia: item => downloadItemMedia({ item, signal: signal.signal })
  });
  const monitor = new ChannelMonitor({
    account, initialSyncBuf: store.data.syncBuf || '', onMessage: async message => {
      await bridge.accept(message);
      if (message.peerId === account.userId) await log(`入站已处理：${message.text.startsWith('/') ? '控制命令' : '任务'}，附件 ${message.media?.length || 0}`);
    },
    onSyncBuf: async buf => { store.data.syncBuf = buf; await store.save(); },
    onError: e => { log(`微信通道异常：${e instanceof Error ? e.message : String(e)}`); },
    onStop: (reason, detail) => { if (reason !== 'aborted') log(detail || reason); }
  });
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { signal.abort(); for (const backend of backends.values()) backend.close(); });
  for (const backend of backends.values()) backend.onDisconnect = e => { log(`[${backend.id}] 后端断开：${e.message}`); signal.abort(); };
  const runtime = { pid: process.pid, status: 'running', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  const saveRuntime = () => writeFile(join(config.stateDir, 'runtime.json'), JSON.stringify(runtime, null, 2), { mode: 0o600 });
  await saveRuntime();
  const stopWatching = await watchStop(config.stateDir, () => { signal.abort(); for (const backend of backends.values()) backend.close(); }, log);
  const heartbeat = setInterval(() => { runtime.heartbeatAt = new Date().toISOString(); saveRuntime().catch(e => log(e.message)); }, 10000);
  try {
    console.log(`微信桥接已启动（引擎：${[...backends.keys()].join('、')}；项目：${Object.keys(config.projects).join('、')}；默认 ${config.defaultAgent}/${config.defaultProject}）；Ctrl+C 停止。`);
    await bridge.recover();
    const reason = await monitor.run(signal.signal);
    if (reason === 'stale-token') throw new Error('微信凭据失效，请停止后重新 npm run login');
    if (reason === 'fatal') throw new Error('微信通道连续失败，已停止，请检查 bridge.log');
  } finally {
    stopWatching(); clearInterval(heartbeat); signal.abort();
    for (const backend of backends.values()) backend.close();
    await Promise.all([...backends.values()].map(b => b.workerPromise));
    runtime.status = 'stopped'; runtime.heartbeatAt = new Date().toISOString(); await saveRuntime();
  }
}

async function main() {
  const command = process.argv[2] || 'help';
  if (!['login', 'start', 'doctor', 'background', 'stop', 'status'].includes(command)) { console.log('用法：run.ps1 doctor | login | start | background | stop | status'); return; }
  // Windows child processes and native networking require these standard variables.
  if (process.platform === 'win32') { process.env.SystemRoot ||= 'C:\\Windows'; process.env.WINDIR ||= process.env.SystemRoot; }
  const config = await loadConfig();
  for (const project of Object.values(config.projects)) await mkdir(project.workspace, { recursive: true });
  await mkdir(config.stateDir, { recursive: true });
  if (command === 'status') { console.log(JSON.stringify(await runtimeStatus(config.stateDir), null, 2)); return; }
  if (command === 'stop') { await requestStop(config.stateDir); console.log('已请求停止后台桥接。'); return; }
  if (command === 'background') {
    const status = await runtimeStatus(config.stateDir);
    if (!status.bound) throw new Error('请先扫码登录');
    const pid = await launchBackground(config.stateDir, process.cwd());
    console.log(`已启动后台桥接，PID ${pid}；使用 run.ps1 status 查看状态。`); return;
  }
  const release = await acquireLock(join(config.stateDir, 'bridge.lock'));
  try {
    const store = await new Storage(join(config.stateDir, 'state.json')).load();
    if (command === 'login') await bind(store, config);
    else if (command === 'doctor') await doctor(config, store);
    else await start(store, config);
  } finally { await release(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
