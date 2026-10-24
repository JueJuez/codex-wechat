import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexClient } from '../src/codex.mjs';

if (process.platform === 'win32') { process.env.SystemRoot ||= 'C:\\Windows'; process.env.WINDIR ||= process.env.SystemRoot; }
const cwd = await mkdtemp(join(tmpdir(), 'codex-wechat-smoke-'));
const client = new CodexClient();
let timer; let threadId; let turnId; let commands = 0;
try {
  await client.initialize();
  const result = await client.call('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  threadId = result.thread.id;
  console.log('真实 Codex 会话已创建，正在验证临时目录文件读写。');
  const done = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('真实任务超过 120 秒')), 120000);
    client.on('disconnected', reject);
    client.on('notification', ({ method, params: p }) => {
      if (p?.threadId !== threadId) return;
      if (method === 'turn/started') turnId = p.turn.id;
      if (method === 'item/completed' && p.item?.type === 'commandExecution') commands++;
      if (method === 'turn/completed') resolve(p.turn);
    });
  });
  client.on('request', msg => {
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(msg.method)) client.respond(msg.id, { decision: 'decline' });
    else client.rejectRequest(msg.id);
  });
  const started = await client.call('turn/start', { threadId, input: [{ type: 'text', text: '请使用本机工具在当前工作目录创建 smoke-proof.txt，内容恰好为 CODEX_WECHAT_SMOKE_OK，然后读取该文件确认内容。请简短回复。' }] });
  turnId = started.turn.id;
  const turn = await done;
  if (turn.status !== 'completed') throw new Error(turn.error?.message || `状态 ${turn.status}`);
  const proof = await readFile(join(cwd, 'smoke-proof.txt'), 'utf8');
  if (proof.trim() !== 'CODEX_WECHAT_SMOKE_OK') throw new Error('文件内容不匹配');
  console.log(JSON.stringify({ status: 'passed', threadId, proofFile: join(cwd, 'smoke-proof.txt'), content: proof.trim(), commandItems: commands, inferenceTurns: 1 }, null, 2));
} catch (e) {
  if (threadId && turnId && !client.closed) await client.call('turn/interrupt', { threadId, turnId }).catch(() => {});
  console.error(e.message); process.exitCode = 1;
} finally { clearTimeout(timer); client.close(); }
