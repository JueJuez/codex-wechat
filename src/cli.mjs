import { readFile, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
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
import { Bridge } from './bridge.mjs';
import { runtimeStatus, launchBackground, requestStop, watchStop } from './lifecycle.mjs';

export async function loadConfig(file = resolve('config.json')) {
  let custom = {};
  try { custom = JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const config = { workspace: process.cwd(), codexPath: 'codex', permissionMode: 'workspace', model: null, maxReplyChars: 3000, ...custom };
  config.workspace = resolve(config.workspace);
  if (!['workspace', 'full'].includes(config.permissionMode)) throw new Error('permissionMode 只能是 workspace 或 full');
  if (!Number.isInteger(config.maxReplyChars) || config.maxReplyChars < 100 || config.maxReplyChars > 4000) throw new Error('maxReplyChars 必须为 100–4000 的整数');
  if (typeof config.codexPath !== 'string' || !config.codexPath) throw new Error('codexPath 无效');
  const workspaceKey = createHash('sha256').update(process.platform === 'win32' ? config.workspace.toLowerCase() : config.workspace).digest('hex').slice(0, 12);
  config.stateDir = resolve(custom.stateDir || join(homedir(), '.codex-wechat', workspaceKey));
  return config;
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
  const client = new CodexClient({ executable: config.codexPath });
  try {
    await client.initialize();
    const account = await client.call('account/read', {});
    console.log(`Codex app-server：握手成功；登录：${account.account ? '已登录' : '未登录'}；微信：${store.data.account?.userId ? '已绑定' : '未绑定'}`);
    console.log(`工作目录：${config.workspace}；权限：${config.permissionMode}；状态目录：${config.stateDir}`);
    console.log('此检查未调用模型，未访问微信。');
  } finally { client.close(); }
}

async function start(store, config) {
  if (!store.data.account?.userId) throw new Error('请先运行 npm run login 完成微信绑定');
  const account = store.data.account;
  const signal = new AbortController();
  const client = new CodexClient({ executable: config.codexPath });
  const log = async message => {
    console.error(message);
    await appendFile(join(config.stateDir, 'bridge.log'), `${new Date().toISOString()} ${message}\n`).catch(() => {});
  };
  try { await client.initialize(); } catch (e) { client.close(); throw e; }
  const bridge = new Bridge({
    codex: client, store, config, log,
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
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { signal.abort(); client.close(); });
  client.on('disconnected', () => signal.abort());
  const runtime = { pid: process.pid, status: 'running', startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() };
  const saveRuntime = () => writeFile(join(config.stateDir, 'runtime.json'), JSON.stringify(runtime, null, 2), { mode: 0o600 });
  await saveRuntime();
  const stopWatching = await watchStop(config.stateDir, () => { signal.abort(); client.close(); }, log);
  const heartbeat = setInterval(() => { runtime.heartbeatAt = new Date().toISOString(); saveRuntime().catch(e => log(e.message)); }, 10000);
  try {
    console.log('微信桥接已启动；Ctrl+C 停止。');
    await bridge.recover();
    const reason = await monitor.run(signal.signal);
    if (reason === 'stale-token') throw new Error('微信凭据失效，请停止后重新 npm run login');
    if (reason === 'fatal') throw new Error('微信通道连续失败，已停止，请检查 bridge.log');
  } finally {
    stopWatching(); clearInterval(heartbeat); signal.abort(); client.close();
    await bridge.workerPromise;
    runtime.status = 'stopped'; runtime.heartbeatAt = new Date().toISOString(); await saveRuntime();
  }
}

async function main() {
  const command = process.argv[2] || 'help';
  if (!['login', 'start', 'doctor', 'background', 'stop', 'status'].includes(command)) { console.log('用法：run.ps1 doctor | login | start | background | stop | status'); return; }
  // Windows child processes and native networking require these standard variables.
  if (process.platform === 'win32') { process.env.SystemRoot ||= 'C:\\Windows'; process.env.WINDIR ||= process.env.SystemRoot; }
  const config = await loadConfig(); await mkdir(config.workspace, { recursive: true }); await mkdir(config.stateDir, { recursive: true });
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
