import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { CodexClient } from './codex.mjs';

export const CODEX_DEV_INSTRUCTIONS = '用户通过微信远程操作本机。请使用简体中文简洁回传结果。用户看不到终端。生成文件后给出工作目录内路径，提示可用 /send 路径 接收。不要声称已经发送文件。';

export function sessionId8(session) { return (session.id || session.ref).slice(-8); }

// codex 不保证在 PATH：ChatGPT 桌面版捆绑在哈希目录里，随升级漂移。
// 顺序：显式路径 → %LOCALAPPDATA%/OpenAI/Codex/bin/*/codex.exe 取最新 → PATH 原值。
export async function resolveCodexExecutable(explicit) {
  if (explicit && explicit !== 'codex') {
    if (existsSync(explicit)) return explicit;
    throw new Error(`codex executable 不存在：${explicit}（ChatGPT 桌面版升级会移动捆绑目录，请更新配置或删除该字段）`);
  }
  const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin') : null;
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  if (root && existsSync(root)) {
    let best = null; let bestMtime = -1;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(root, entry.name, name);
      try { const info = statSync(candidate); if (info.isFile() && info.mtimeMs > bestMtime) { best = candidate; bestMtime = info.mtimeMs; } }
      catch { continue; }
    }
    if (best) return best;
  }
  return explicit || 'codex';
}

// 每后端一个实例：串行队列（后端内一次一个任务），后端之间并行。
// 子类必须实现 ensureSession / sendTurn；可选覆盖 init/close/connected/statusNote/cancelConversation。
export class AgentBackend {
  constructor({ id, workspace }) {
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`后端 id 无效（小写字母开头，可含数字/-）：${id}`);
    this.id = id; this.label = id; this.workspace = workspace;
    this.approvals = new Map(); this.counter = 0;
    this.working = false; this.workerPromise = Promise.resolve(); this.currentMessage = null;
    this.onDisconnect = null;
  }
  attach({ store, config, reply, downloadMedia, log }) { Object.assign(this, { store, config, reply, downloadMedia, log }); }
  get connected() { return true; }
  async init() {}
  close() {}
  statusNote() { return ''; }
  approvalsPending() { return this.approvals.size; }
  domain(conv) { conv.sessions[this.id] ??= []; return conv.sessions[this.id]; }
  currentRef(conv) { return conv.current?.[this.id] || null; }
  sessionByRef(conv, ref) { return ref ? this.domain(conv).find(s => s.ref === ref) : null; }
  async ensureSession(conv, title = '微信会话') { throw new Error(`${this.id} 未实现 ensureSession`); }
  // 返回 { status: 'completed'|'failed'|'interrupted', output?, error? }
  async sendTurn(text, files, session, message) { throw new Error(`${this.id} 未实现 sendTurn`); }
  async interrupt() {}
  async cancelConversation() {}
  async prepareFiles(message) {
    const files = [];
    for (const item of message.media ?? []) {
      const media = await this.downloadMedia(item);
      if (!media) throw new Error('附件缺少下载信息');
      const dir = join(this.workspace, '.codex-wechat', 'inbox', randomUUID());
      await mkdir(dir, { recursive: true });
      const safeName = basename(media.fileName.replaceAll('\\', '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'attachment.bin';
      const file = join(dir, safeName); await writeFile(file, media.data);
      files.push({ path: file, kind: media.kind });
    }
    return files;
  }
  nextJob() { return this.store.data.jobs.find(j => j.status === 'pending' && j.agent === this.id && !j.message.text.startsWith('/')); }
  remove(job) { this.store.data.jobs = this.store.data.jobs.filter(j => j.id !== job.id); }
  pump() {
    if (this.working) return;
    this.working = true;
    this.workerPromise = this.work().catch(e => this.log?.(`[${this.id}] 队列异常：${e.message}`)).finally(() => {
      this.working = false;
      if (this.nextJob()) this.pump();
    });
  }
  async work() {
    while (this.connected) {
      const job = this.nextJob();
      if (!job) return;
      job.status = 'running'; await this.store.save();
      try { await this.execute(job.message, job); }
      catch (e) { await this.reply(job.message, `任务失败：${e.message}`); }
      finally { this.remove(job); await this.store.save(); }
    }
  }
  async execute(message, job) {
    const conv = this.store.data.conversations[message.conversationId];
    const files = await this.prepareFiles(message);
    if (job.cancelled) return this.reply(message, '任务已在准备阶段取消。');
    let session = this.sessionByRef(conv, this.currentRef(conv));
    if (!session) { session = await this.ensureSession(conv, message.text.slice(0, 32) || '微信附件'); await this.store.save(); }
    await this.reply(message, `已收到，${this.label} 开始处理。`);
    if (job.cancelled) return this.reply(message, '任务已取消。');
    this.currentMessage = message;
    let result;
    try { result = await this.sendTurn(message.text || '请处理这些附件', files, session, message); }
    finally { this.currentMessage = null; await this.store.save(); }
    if (result.status === 'completed') await this.reply(message, result.output || '任务完成，未返回文字。');
    else await this.reply(message, `${result.status === 'interrupted' ? '任务已停止' : '任务失败'}${result.error ? '：' + result.error : ''}${result.output ? '\n' + result.output : ''}`);
  }
}

export class CodexBackend extends AgentBackend {
  constructor({ id = 'codex', workspace, permissionMode = 'workspace', model = null, executable = 'codex', client = null }) {
    super({ id, workspace });
    this.permissionMode = permissionMode; this.model = model;
    this.client = client ?? new CodexClient({ executable });
    this.active = new Map(); this.resumed = new Set(); this.dead = false;
    this.client.on('notification', msg => this.notification(msg));
    this.client.on('request', msg => { this.request(msg).catch(e => { this.log?.(e.message); try { this.client.rejectRequest(msg.id); } catch {} }); });
    this.client.on('disconnected', e => {
      this.dead = true;
      for (const run of this.active.values()) run.finish({ status: 'failed', error: { message: e.message } });
      this.onDisconnect?.(e);
    });
  }
  get connected() { return !this.dead; }
  close() { this.client.close(); }
  statusNote() { return `权限 ${this.permissionMode}`; }
  turnParams() {
    return this.permissionMode === 'full'
      ? { approvalPolicy: 'never', sandbox: 'danger-full-access' }
      : { approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  }
  async ensureSession(conv, title = '微信会话') {
    const result = await this.client.call('thread/start', {
      cwd: this.workspace, ...this.turnParams(),
      ...(this.model ? { model: this.model } : {}),
      developerInstructions: CODEX_DEV_INSTRUCTIONS
    });
    const session = { ref: result.thread.id, id: result.thread.id, title, createdAt: new Date().toISOString() };
    this.domain(conv).push(session); conv.current ??= {}; conv.current[this.id] = session.ref;
    this.resumed.add(session.id);
    return session;
  }
  async sendTurn(text, files, session, message) {
    const threadId = session.id;
    if (!this.resumed.has(threadId)) {
      await this.client.call('thread/resume', { threadId, cwd: this.workspace, ...this.turnParams() });
      this.resumed.add(threadId);
    }
    const input = [{ type: 'text', text: text + (files.length ? '\n附件已保存到本机：\n' + files.map(f => f.path).join('\n') : '') }];
    for (const file of files) if (file.kind === 'image') input.push({ type: 'localImage', path: file.path });
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const run = { message, finish, items: new Map(), toolItems: new Map(), turnId: null };
    this.active.set(threadId, run);
    try {
      const started = await this.client.call('turn/start', { threadId, input });
      run.turnId = started.turn.id;
      if (run.cancelRequested) await this.client.call('turn/interrupt', { threadId, turnId: run.turnId });
      const turn = await done;
      return { status: turn.status, output: [...run.items.values()].join('\n\n'), error: turn.error?.message };
    } finally {
      this.active.delete(threadId);
      for (const [id, approval] of this.approvals) if (approval.threadId === threadId) this.approvals.delete(id);
    }
  }
  async cancelConversation(conversationId) {
    for (const [id, approval] of this.approvals) if (approval.message.conversationId === conversationId) {
      this.client.respond(approval.rpcId, approval.kind === 'question' ? { answers: {} } : { decision: 'cancel' });
      this.approvals.delete(id);
    }
    for (const [threadId, run] of this.active) if (run.message.conversationId === conversationId) {
      if (run.turnId) await this.client.call('turn/interrupt', { threadId, turnId: run.turnId });
      else run.cancelRequested = true;
    }
  }
  notification({ method, params: p }) {
    const run = this.active.get(p?.threadId);
    if (method === 'serverRequest/resolved') for (const [id, a] of this.approvals) if (a.rpcId === p.requestId) this.approvals.delete(id);
    if (!run) return;
    if (method === 'turn/started') run.turnId = p.turn.id;
    if (method === 'item/started' || method === 'item/completed') run.toolItems.set(p.item.id, p.item);
    if (method === 'item/agentMessage/delta') run.items.set(p.itemId, (run.items.get(p.itemId) || '') + p.delta);
    if (method === 'item/completed' && p.item?.type === 'agentMessage') run.items.set(p.item.id, p.item.text);
    if (method === 'turn/completed') run.finish(p.turn);
  }
  async request({ id: rpcId, method, params: p }) {
    const run = this.active.get(p.threadId);
    if (!run) return this.client.rejectRequest(rpcId);
    const approvalId = `${this.id[0]}${++this.counter}`;
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.approvals.set(approvalId, { rpcId, threadId: p.threadId, message: run.message, kind: 'approval', available: p.availableDecisions });
      const item = run.toolItems.get(p.itemId);
      const detail = method === 'item/fileChange/requestApproval'
        ? (item?.changes?.map(c => `${c.path}\n${c.diff || ''}`).join('\n') || p.reason || '请求修改文件')
        : p.command || item?.command || p.reason || '请求执行命令';
      try { await this.reply(run.message, `审批 ${approvalId}\n${detail}\n${p.cwd ? '目录：' + p.cwd + '\n' : ''}/approve ${approvalId} 同意一次\n/deny ${approvalId} 拒绝`); }
      catch (e) { this.approvals.delete(approvalId); this.client.respond(rpcId, { decision: 'decline' }); throw e; }
    } else if (method === 'item/tool/requestUserInput') {
      this.approvals.set(approvalId, { rpcId, threadId: p.threadId, message: run.message, kind: 'question', questions: p.questions, answers: {} });
      await this.reply(run.message, p.questions.map(q => `问题 ${approvalId} / ${q.id}：${q.question}\n${q.options?.map(o => o.label + '：' + o.description).join('\n') || ''}\n/answer ${approvalId} ${q.id} 回答`).join('\n\n'));
    } else {
      this.client.rejectRequest(rpcId);
      await this.reply(run.message, `此操作需要桥接尚未支持的交互：${method}。已拒绝请求。`);
    }
  }
}

function cleanTerminalOutput(text) {
  const cleaned = String(text || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return cleaned.length > 4000 ? `（输出过长，仅保留末尾）\n…${cleaned.slice(-3900)}` : cleaned;
}

function lastLines(text, count = 8) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  return lines.slice(-count).join('\n').slice(-1500);
}

// 一期：每条消息一次 headless 进程（node zcode.cjs -p …），--json 拿结构化结果。
// yolo 模式没有中途审批通道，等于预授权放行；务必给独立 workspace。
export class ZcodeBackend extends AgentBackend {
  constructor({ id = 'zcode', workspace, node = 'node', cli, mode = 'yolo', locale = 'zh-CN' }) {
    super({ id, workspace });
    this.node = node; this.cli = cli; this.mode = mode; this.locale = locale;
    this.current = null; this.interruptRequested = false;
  }
  statusNote() { return `模式 ${this.mode}（无审批转发）`; }
  async ensureSession(conv, title = '微信会话') {
    const session = { ref: randomUUID(), id: null, title, createdAt: new Date().toISOString() };
    this.domain(conv).push(session); conv.current ??= {}; conv.current[this.id] = session.ref;
    return session;
  }
  async sendTurn(text, files, session) {
    const args = [this.cli, '-p', text, '--cwd', this.workspace, '--mode', this.mode, '--json'];
    if (this.locale) args.push('--locale', this.locale);
    if (session.id) args.push('--resume', session.id);
    for (const file of files) args.push('--attach', file.path);
    this.interruptRequested = false;
    const child = spawn(this.node, args, { cwd: this.workspace, windowsHide: true });
    this.current = child;
    let stdout = ''; let stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    return await new Promise(resolve => {
      child.on('error', e => { this.current = null; resolve({ status: 'failed', error: e.message }); });
      child.on('exit', (code, signal) => {
        this.current = null;
        const sessId = /sess_[A-Za-z0-9-]+/.exec(stdout)?.[0];
        if (sessId && !session.id) session.id = sessId;
        if (this.interruptRequested || signal) return resolve({ status: 'interrupted', output: cleanTerminalOutput(stdout) });
        let parsed = null;
        try { parsed = JSON.parse(stdout); } catch { try { parsed = JSON.parse(stdout.slice(stdout.indexOf('{'), stdout.lastIndexOf('}') + 1)); } catch {} }
        if (parsed?.sessionId && !session.id) session.id = parsed.sessionId;
        if (code === 0) {
          const output = cleanTerminalOutput(typeof parsed?.response === 'string' && parsed.response.trim() ? parsed.response : stdout);
          resolve({ status: 'completed', output: output || '任务完成，未返回文字。' });
        } else {
          resolve({ status: 'failed', error: lastLines(stderr || stdout) || `zcode 进程退出码 ${code}` });
        }
      });
    });
  }
  async interrupt() {
    if (this.current && !this.current.killed) { this.interruptRequested = true; this.current.kill(); }
  }
  async cancelConversation(conversationId) {
    if (this.currentMessage?.conversationId === conversationId) await this.interrupt();
  }
}
