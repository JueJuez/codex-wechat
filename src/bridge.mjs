import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, realpath, readFile, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve, basename } from 'node:path';

export const HELP = '/new 标题 新会话\n/list 会话列表\n/switch 序号 切换\n/current 当前会话\n/status 运行状态\n/cancel 取消任务及排队消息\n/approve 编号 同意一次\n/deny 编号 拒绝\n/answer 编号 问题ID 回答\n/send 路径 回传工作区文件\n/help 帮助';

export async function confinedFile(workspace, target) {
  const root = await realpath(workspace);
  const file = await realpath(resolve(root, target));
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) throw new Error('只能发送工作目录内的文件');
  const info = await stat(file);
  if (!info.isFile() || info.size > 100 * 1024 * 1024) throw new Error('文件无效或大于 100MB');
  return file;
}

export class Bridge {
  constructor({ codex, store, config, sendText, sendFile, downloadMedia, log = console.error }) {
    Object.assign(this, { codex, store, config, sendText, sendFile, downloadMedia, log });
    this.active = new Map(); this.approvals = new Map(); this.counter = 0; this.resumed = new Set(); this.outgoing = Promise.resolve();
    codex.on('notification', msg => this.notification(msg));
    codex.on('request', msg => { this.request(msg).catch(e => { this.log(e.message); try { codex.rejectRequest(msg.id); } catch {} }); });
    codex.on('disconnected', e => {
      this.dead = true;
      for (const run of this.active.values()) run.finish({ status: 'failed', error: { message: e.message } });
    });
  }
  conversation(message) {
    return this.store.data.conversations[message.conversationId] ??= { peerId: message.peerId, sessions: [], current: null };
  }
  reply(message, text) {
    const next = this.outgoing.catch(() => {}).then(async () => {
      const chars = Array.from(text || '任务完成，未返回文字。');
      const limit = this.config.maxReplyChars;
      for (let i = 0; i < chars.length; i += limit) await this.sendText(message, chars.slice(i, i + limit).join(''));
    });
    this.outgoing = next;
    return next;
  }
  async accept(message) {
    if (!this.store.data.account?.userId || message.peerId !== this.store.data.account.userId || message.groupId) return;
    const key = message.messageId ? `${message.accountId}:${message.messageId}` : null;
    if (key && this.store.data.seen.includes(key)) return;
    const conv = this.conversation(message);
    if (message.contextToken) conv.contextToken = message.contextToken;
    if (this.store.data.jobs.length >= 100) throw new Error('待处理消息已达 100 条，请先取消或等待');
    const job = { id: randomUUID(), message, status: 'pending' };
    this.store.data.jobs.push(job);
    if (key) { this.store.data.seen.push(key); this.store.data.seen = this.store.data.seen.slice(-2000); }
    try { await this.store.save(); }
    catch (e) { this.remove(job); if (key) this.store.data.seen = this.store.data.seen.filter(k => k !== key); throw e; }
    if (message.text.startsWith('/')) await this.executeCommand(job);
    else this.pump();
  }
  async recover() {
    for (const job of [...this.store.data.jobs]) {
      if (job.status === 'running') {
        await this.reply(job.message, '桥接程序上次中断，任务结果未知，未自动重跑。可继续询问当前状态。');
        this.remove(job);
      } else if (job.message.text.startsWith('/')) await this.executeCommand(job);
    }
    await this.store.save(); this.pump();
  }
  remove(job) { this.store.data.jobs = this.store.data.jobs.filter(j => j.id !== job.id); }
  async executeCommand(job) {
    job.status = 'running'; await this.store.save();
    try { await this.command(job.message); }
    catch (e) { await this.reply(job.message, `操作失败：${e.message}`); }
    finally { this.remove(job); await this.store.save(); }
  }
  async command(message) {
    const [command, ...rest] = message.text.trim().split(/\s+/); const arg = rest.join(' ');
    const conv = this.conversation(message);
    const busy = this.store.data.jobs.some(j => !j.message.text.startsWith('/') && j.message.conversationId === message.conversationId);
    if (command === '/help') return this.reply(message, HELP);
    if (command === '/status') return this.reply(message, `Codex ${this.dead ? '已断开' : '已连接'}；${busy ? '任务执行中' : '空闲'}；排队 ${this.store.data.jobs.filter(j => j.status === 'pending' && !j.message.text.startsWith('/')).length} 条；审批 ${this.approvals.size} 项；权限 ${this.config.permissionMode}`);
    if (command === '/new') {
      if (busy) throw new Error('请先 /cancel 或等任务完成再新建');
      const session = await this.newSession(conv, arg || '微信会话');
      await this.store.save(); return this.reply(message, `已新建：${session.title}（${session.id.slice(-8)}）`);
    }
    if (command === '/list') return this.reply(message, conv.sessions.map((s, i) => `${i + 1}. ${s.id === conv.current ? '→ ' : ''}${s.title} [${s.id.slice(-8)}]`).join('\n') || '暂无会话，发送任务会自动创建。');
    if (command === '/switch') {
      if (busy) throw new Error('请先 /cancel 或等任务完成再切换');
      const session = /^\d+$/.test(arg) ? conv.sessions[Number(arg) - 1] : conv.sessions.find(s => s.id === arg);
      if (!session) throw new Error('序号无效，请 /list 查看');
      conv.current = session.id; await this.store.save(); return this.reply(message, `已切换：${session.title}`);
    }
    if (command === '/current') return this.reply(message, conv.sessions.find(s => s.id === conv.current)?.title || '尚未创建会话');
    if (command === '/cancel') {
      for (const job of this.store.data.jobs) if (job.status === 'running' && !job.message.text.startsWith('/') && job.message.conversationId === message.conversationId) job.cancelled = true;
      this.store.data.jobs = this.store.data.jobs.filter(j => j.message.conversationId !== message.conversationId || j.status === 'running');
      for (const [id, approval] of this.approvals) if (approval.message.conversationId === message.conversationId) {
        this.codex.respond(approval.rpcId, approval.kind === 'question' ? { answers: {} } : { decision: 'cancel' });
        this.approvals.delete(id);
      }
      for (const [threadId, run] of this.active) if (run.message.conversationId === message.conversationId) {
        if (run.turnId) await this.codex.call('turn/interrupt', { threadId, turnId: run.turnId });
        else run.cancelRequested = true;
      }
      await this.store.save(); return this.reply(message, '已请求停止，排队消息已清除。');
    }
    if (command === '/approve' || command === '/deny' || command === '/answer') {
      const approval = this.approvals.get(rest[0]);
      if (!approval || approval.message.conversationId !== message.conversationId) throw new Error('审批编号不存在或已过期');
      if (approval.kind === 'question') {
        if (command !== '/answer') throw new Error('请使用 /answer 编号 问题ID 回答');
        const question = approval.questions.find(q => q.id === rest[1]);
        if (!question || rest.length < 3) throw new Error('问题ID或回答无效');
        approval.answers[question.id] = { answers: [rest.slice(2).join(' ')] };
        if (approval.questions.some(q => !approval.answers[q.id])) return this.reply(message, '已记录，请继续回答其他问题。');
        this.codex.respond(approval.rpcId, { answers: approval.answers });
      } else {
        if (command === '/answer') throw new Error('请使用 /approve 或 /deny');
        const decision = command === '/approve' ? 'accept' : 'decline';
        if (approval.available && !approval.available.includes(decision)) throw new Error('当前请求不支持此决定');
        this.codex.respond(approval.rpcId, { decision });
      }
      this.approvals.delete(rest[0]); return this.reply(message, '已提交。');
    }
    if (command === '/send') {
      if (!arg) throw new Error('请输入文件路径');
      const file = await confinedFile(this.config.workspace, arg);
      await this.sendFile(message, file); return;
    }
    throw new Error('未知命令，使用 /help 查看');
  }
  async newSession(conv, title) {
    const result = await this.codex.call('thread/start', {
      cwd: this.config.workspace,
      approvalPolicy: this.config.permissionMode === 'full' ? 'never' : 'on-request',
      sandbox: this.config.permissionMode === 'full' ? 'danger-full-access' : 'workspace-write',
      ...(this.config.model ? { model: this.config.model } : {}),
      developerInstructions: '用户通过微信远程操作本机。请使用简体中文简洁回传结果。用户看不到终端。生成文件后给出工作目录内路径，提示可用 /send 路径 接收。不要声称已经发送文件。'
    });
    const session = { id: result.thread.id, title, createdAt: new Date().toISOString() };
    conv.sessions.push(session); conv.current = session.id; this.resumed.add(session.id); return session;
  }
  pump() {
    if (this.working || this.dead) return;
    this.working = true;
    this.workerPromise = this.work().catch(e => { this.dead = true; this.log(e.message); }).finally(() => {
      this.working = false;
      if (!this.dead && this.store.data.jobs.some(j => j.status === 'pending' && !j.message.text.startsWith('/'))) this.pump();
    });
  }
  async work() {
    while (!this.dead) {
      const job = this.store.data.jobs.find(j => j.status === 'pending' && !j.message.text.startsWith('/'));
      if (!job) return;
      job.status = 'running'; await this.store.save();
      try { await this.run(job.message, job); }
      catch (e) { await this.reply(job.message, `任务失败：${e.message}`); }
      finally { this.remove(job); await this.store.save(); }
    }
  }
  async run(message, job = {}) {
    const conv = this.conversation(message);
    if (!conv.current) { await this.newSession(conv, message.text.slice(0, 32) || '微信附件'); await this.store.save(); }
    const threadId = conv.current;
    if (!this.resumed.has(threadId)) {
      await this.codex.call('thread/resume', { threadId, cwd: this.config.workspace,
        approvalPolicy: this.config.permissionMode === 'full' ? 'never' : 'on-request',
        sandbox: this.config.permissionMode === 'full' ? 'danger-full-access' : 'workspace-write' });
      this.resumed.add(threadId);
    }
    const input = []; const files = [];
    for (const item of message.media ?? []) {
      const media = await this.downloadMedia(item);
      if (!media) throw new Error('附件缺少下载信息');
      const dir = join(this.config.workspace, '.codex-wechat', 'inbox', randomUUID()); await mkdir(dir, { recursive: true });
      const safeName = basename(media.fileName.replaceAll('\\', '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_') || 'attachment.bin';
      const file = join(dir, safeName); await writeFile(file, media.data);
      files.push(file); if (media.kind === 'image') input.push({ type: 'localImage', path: file });
    }
    input.unshift({ type: 'text', text: (message.text || '请处理这些附件') + (files.length ? '\n附件已保存到本机：\n' + files.join('\n') : '') });
    if (job.cancelled) return this.reply(message, '任务已在准备阶段取消。');
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    const run = { message, finish, items: new Map(), toolItems: new Map(), turnId: null }; this.active.set(threadId, run);
    try {
      await this.reply(message, '已收到，Codex 开始处理。');
      if (job.cancelled) return this.reply(message, '任务已取消。');
      const started = await this.codex.call('turn/start', { threadId, input });
      run.turnId = started.turn.id;
      if (run.cancelRequested) await this.codex.call('turn/interrupt', { threadId, turnId: run.turnId });
      const turn = await done;
      const output = [...run.items.values()].join('\n\n');
      if (turn.status === 'completed') await this.reply(message, output || '任务完成，未返回文字。');
      else await this.reply(message, `${turn.status === 'interrupted' ? '任务已停止' : '任务失败'}${turn.error?.message ? '：' + turn.error.message : ''}${output ? '\n' + output : ''}`);
    } finally {
      this.active.delete(threadId);
      for (const [id, approval] of this.approvals) if (approval.threadId === threadId) this.approvals.delete(id);
    }
  }
  notification({ method, params: p }) {
    const run = this.active.get(p?.threadId);
    if (method === 'serverRequest/resolved') {
      for (const [id, a] of this.approvals) if (a.rpcId === p.requestId) this.approvals.delete(id);
    }
    if (!run) return;
    if (method === 'turn/started') run.turnId = p.turn.id;
    if (method === 'item/started' || method === 'item/completed') run.toolItems.set(p.item.id, p.item);
    if (method === 'item/agentMessage/delta') run.items.set(p.itemId, (run.items.get(p.itemId) || '') + p.delta);
    if (method === 'item/completed' && p.item?.type === 'agentMessage') run.items.set(p.item.id, p.item.text);
    if (method === 'turn/completed') run.finish(p.turn);
  }
  async request({ id: rpcId, method, params: p }) {
    const run = this.active.get(p.threadId);
    if (!run) return this.codex.rejectRequest(rpcId);
    const id = String(++this.counter);
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      this.approvals.set(id, { rpcId, threadId: p.threadId, message: run.message, kind: 'approval', available: p.availableDecisions });
      const item = run.toolItems.get(p.itemId);
      const detail = method === 'item/fileChange/requestApproval'
        ? (item?.changes?.map(c => `${c.path}\n${c.diff || ''}`).join('\n') || p.reason || '请求修改文件')
        : p.command || item?.command || p.reason || '请求执行命令';
      try { await this.reply(run.message, `审批 ${id}\n${detail}\n${p.cwd ? '目录：' + p.cwd + '\n' : ''}/approve ${id} 同意一次\n/deny ${id} 拒绝`); }
      catch (e) { this.approvals.delete(id); this.codex.respond(rpcId, { decision: 'decline' }); throw e; }
    } else if (method === 'item/tool/requestUserInput') {
      this.approvals.set(id, { rpcId, threadId: p.threadId, message: run.message, kind: 'question', questions: p.questions, answers: {} });
      await this.reply(run.message, p.questions.map(q => `问题 ${id} / ${q.id}：${q.question}\n${q.options?.map(o => o.label + '：' + o.description).join('\n') || ''}\n/answer ${id} ${q.id} 回答`).join('\n\n'));
    } else {
      this.codex.rejectRequest(rpcId);
      await this.reply(run.message, `此操作需要桥接尚未支持的交互：${method}。已拒绝请求。`);
    }
  }
}
