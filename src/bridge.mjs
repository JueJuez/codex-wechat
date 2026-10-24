import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { join, relative, isAbsolute, resolve } from 'node:path';
import { sessionId8 } from './backend.mjs';

export const HELP = '@后端 任务 指定后端执行（如 @codex / @zcode）\n/use 后端 设置本会话默认后端\n/new 标题 新会话（默认后端）\n/list 会话列表（按后端分组）\n/switch [后端] 序号 切换会话\n/current 当前会话\n/status 各后端状态\n/cancel [后端] 取消任务及排队消息\n/approve 编号 同意一次（编号形如 c1）\n/deny 编号 拒绝\n/answer 编号 问题ID 回答\n/send 路径 回传默认后端工作区文件\n/help 帮助';

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
  // backends: Map<id, AgentBackend>，由 cli 装配；Bridge 只做路由、命令与会话簿记。
  constructor({ backends, store, config, sendText, sendFile, downloadMedia, log = console.error }) {
    Object.assign(this, { backends, store, config, sendText, sendFile, downloadMedia, log });
    this.outgoing = Promise.resolve();
    for (const backend of backends.values()) {
      backend.attach({ store, config, reply: (m, t) => this.reply(m, t, backend.label), downloadMedia, log });
    }
  }
  conversation(message) {
    return this.store.data.conversations[message.conversationId] ??= { peerId: message.peerId, sessions: {}, current: {}, defaultAgent: null };
  }
  defaultAgentId(conv) {
    if (conv.defaultAgent && this.backends.has(conv.defaultAgent)) return conv.defaultAgent;
    return this.config.defaultAgent;
  }
  reply(message, text, label = null) {
    const body = label ? `[${label}] ${text || '任务完成，未返回文字。'}` : (text || '任务完成，未返回文字。');
    const next = this.outgoing.catch(() => {}).then(async () => {
      const chars = Array.from(body);
      const limit = this.config.maxReplyChars;
      for (let i = 0; i < chars.length; i += limit) await this.sendText(message, chars.slice(i, i + limit).join(''));
    });
    this.outgoing = next;
    return next;
  }
  recordSeen(key) {
    if (!key) return;
    this.store.data.seen.push(key);
    this.store.data.seen = this.store.data.seen.slice(-2000);
  }
  async accept(message) {
    if (!this.store.data.account?.userId || message.peerId !== this.store.data.account.userId || message.groupId) return;
    const key = message.messageId ? `${message.accountId}:${message.messageId}` : null;
    if (key && this.store.data.seen.includes(key)) return;
    const conv = this.conversation(message);
    if (message.contextToken) conv.contextToken = message.contextToken;
    if (this.store.data.jobs.length >= 100) throw new Error('待处理消息已达 100 条，请先取消或等待');
    let agentId = null;
    if (!message.text.startsWith('/')) {
      const at = /^@([A-Za-z][A-Za-z0-9-]*)(?:\s+([\s\S]+))?$/.exec(message.text.trim());
      if (at) {
        const backend = this.backends.get(at[1].toLowerCase());
        if (!backend || !at[2]) {
          this.recordSeen(key);
          try { await this.store.save(); }
          catch (e) { if (key) this.store.data.seen = this.store.data.seen.filter(k => k !== key); throw e; }
          if (!backend) return this.reply(message, `未知后端 @${at[1]}。可用：${[...this.backends.keys()].map(k => '@' + k).join('、')}；/use 后端 设置默认。`);
          return this.reply(message, `请在 @${backend.id} 后写任务内容，例如：@${backend.id} 列出当前目录`);
        }
        message = { ...message, text: at[2].trim() };
        agentId = backend.id;
      } else agentId = this.defaultAgentId(conv);
    }
    const job = { id: randomUUID(), message, status: 'pending', ...(agentId ? { agent: agentId } : {}) };
    this.store.data.jobs.push(job);
    this.recordSeen(key);
    try { await this.store.save(); }
    catch (e) { this.remove(job); if (key) this.store.data.seen = this.store.data.seen.filter(k => k !== key); throw e; }
    if (agentId) this.backends.get(agentId).pump();
    else await this.executeCommand(job);
  }
  async recover() {
    for (const job of [...this.store.data.jobs]) {
      if (job.status === 'running') {
        await this.reply(job.message, '桥接程序上次中断，任务结果未知，未自动重跑。可继续询问当前状态。');
        this.remove(job);
      } else if (job.message.text.startsWith('/')) await this.executeCommand(job);
      else if (!this.backends.has(job.agent)) job.agent = this.config.defaultAgent;
    }
    await this.store.save();
    for (const backend of this.backends.values()) backend.pump();
  }
  remove(job) { this.store.data.jobs = this.store.data.jobs.filter(j => j.id !== job.id); }
  async executeCommand(job) {
    job.status = 'running'; await this.store.save();
    try { await this.command(job.message); }
    catch (e) { await this.reply(job.message, `操作失败：${e.message}`); }
    finally { this.remove(job); await this.store.save(); }
  }
  commandTasks(conversationId, backendId = null) {
    return this.store.data.jobs.filter(j => !j.message.text.startsWith('/') && j.message.conversationId === conversationId && (!backendId || j.agent === backendId));
  }
  async command(message) {
    const [command, ...rest] = message.text.trim().split(/\s+/);
    const arg = rest.join(' ');
    const conv = this.conversation(message);
    if (command === '/help') return this.reply(message, HELP);
    if (command === '/status') return this.reply(message, this.statusText());
    if (command === '/use') {
      const backend = this.backends.get((rest[0] || '').toLowerCase());
      if (!backend) throw new Error(`用法：/use ${[...this.backends.keys()].join('|')}`);
      conv.defaultAgent = backend.id; await this.store.save();
      return this.reply(message, `本会话默认后端已设为 ${backend.id}。`);
    }
    if (command === '/new') {
      const backend = this.backends.get(this.defaultAgentId(conv));
      if (this.commandTasks(message.conversationId, backend.id).length) throw new Error(`请先 /cancel ${backend.id} 或等任务完成再新建`);
      const session = await backend.ensureSession(conv, arg || '微信会话');
      await this.store.save();
      return this.reply(message, `已新建（${backend.id}）：${session.title}（${sessionId8(session)}）`);
    }
    if (command === '/list') return this.reply(message, this.listText(conv));
    if (command === '/current') return this.reply(message, this.currentText(conv));
    if (command === '/switch') {
      const [first, second, ...extra] = rest;
      let backend; let key;
      if (second !== undefined && this.backends.has((first || '').toLowerCase())) { backend = this.backends.get(first.toLowerCase()); key = second; }
      else { backend = this.backends.get(this.defaultAgentId(conv)); key = first; }
      if (extra.length || !key) throw new Error('用法：/switch [后端] 序号');
      if (this.commandTasks(message.conversationId, backend.id).length) throw new Error(`请先 /cancel ${backend.id} 或等任务完成再切换`);
      const sessions = conv.sessions[backend.id] || [];
      const session = /^\d+$/.test(key) ? sessions[Number(key) - 1] : sessions.find(s => s.id === key || sessionId8(s) === key);
      if (!session) throw new Error('序号无效，请 /list 查看');
      conv.current[backend.id] = session.ref; await this.store.save();
      return this.reply(message, `已切换（${backend.id}）：${session.title}`);
    }
    if (command === '/cancel') {
      const target = (rest[0] || '').toLowerCase();
      if (target && !this.backends.has(target)) throw new Error(`未知后端 ${target}；/cancel 不带参数作用于全部后端`);
      const targets = target ? [this.backends.get(target)] : [...this.backends.values()];
      for (const job of this.store.data.jobs) if (!job.message.text.startsWith('/') && job.message.conversationId === message.conversationId && (!target || job.agent === target)) job.cancelled = true;
      this.store.data.jobs = this.store.data.jobs.filter(j => j.message.conversationId !== message.conversationId || (target && j.agent !== target) || j.status === 'running');
      for (const backend of targets) await backend.cancelConversation(message.conversationId);
      await this.store.save();
      return this.reply(message, target ? `已请求停止 ${target} 的任务，排队消息已清除。` : '已请求停止所有后端任务，排队消息已清除。');
    }
    if (command === '/approve' || command === '/deny' || command === '/answer') {
      const parsed = /^([a-z])(\d+)$/i.exec(rest[0] || '');
      const backend = parsed && [...this.backends.values()].find(b => b.id[0] === parsed[1].toLowerCase());
      const approvalId = parsed && backend ? `${parsed[1].toLowerCase()}${Number(parsed[2])}` : null;
      const approval = approvalId && backend.approvals.get(approvalId);
      if (!approval || approval.message.conversationId !== message.conversationId) throw new Error('审批编号不存在或已过期，请查看对应后端发来的编号（形如 c1）');
      if (approval.kind === 'question') {
        if (command !== '/answer') throw new Error('请使用 /answer 编号 问题ID 回答');
        const question = approval.questions.find(q => q.id === rest[1]);
        if (!question || rest.length < 3) throw new Error('问题ID或回答无效');
        approval.answers[question.id] = { answers: [rest.slice(2).join(' ')] };
        if (approval.questions.some(q => !approval.answers[q.id])) return this.reply(message, '已记录，请继续回答其他问题。');
        backend.client.respond(approval.rpcId, { answers: approval.answers });
      } else {
        if (command === '/answer') throw new Error('请使用 /approve 或 /deny');
        const decision = command === '/approve' ? 'accept' : 'decline';
        if (approval.available && !approval.available.includes(decision)) throw new Error('当前请求不支持此决定');
        backend.client.respond(approval.rpcId, { decision });
      }
      backend.approvals.delete(approvalId); return this.reply(message, '已提交。');
    }
    if (command === '/send') {
      if (!arg) throw new Error('请输入文件路径');
      const backend = this.backends.get(this.defaultAgentId(conv));
      const file = await confinedFile(backend.workspace, arg);
      await this.sendFile(message, file); return;
    }
    throw new Error('未知命令，使用 /help 查看');
  }
  statusText() {
    const lines = [`全局排队 ${this.store.data.jobs.filter(j => j.status === 'pending' && !j.message.text.startsWith('/')).length} 条`];
    for (const [id, backend] of this.backends) {
      const queued = this.store.data.jobs.filter(j => j.status === 'pending' && j.agent === id && !j.message.text.startsWith('/')).length;
      const parts = [`${id} ${backend.connected ? '已连接' : '已断开'}`, `运行 ${backend.working ? 1 : 0}`, `排队 ${queued}`, `审批 ${backend.approvalsPending()}`, `工作区 ${backend.workspace}`];
      const note = backend.statusNote();
      if (note) parts.push(note);
      lines.push(parts.join('；'));
    }
    if (this.config.sharedWorkspaceWarning) lines.push(`⚠ ${this.config.sharedWorkspaceWarning}`);
    return lines.join('\n');
  }
  listText(conv) {
    const lines = [];
    for (const [id] of this.backends) {
      const sessions = conv.sessions[id] || [];
      lines.push(`[${id}]${sessions.length ? '' : ' 暂无会话'}`);
      sessions.forEach((s, i) => lines.push(`${i + 1}. ${s.ref === conv.current?.[id] ? '→ ' : ''}${s.title} [${sessionId8(s)}]`));
    }
    return lines.join('\n');
  }
  currentText(conv) {
    const lines = [];
    for (const [id, backend] of this.backends) {
      const session = (conv.sessions[id] || []).find(s => s.ref === conv.current?.[id]);
      lines.push(`[${id}] ${session ? `${session.title}（${sessionId8(session)}）` : '无'}`);
    }
    lines.push(`默认后端：${this.defaultAgentId(conv)}`);
    return lines.join('\n');
  }
}
