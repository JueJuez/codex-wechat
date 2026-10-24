import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/cli.mjs';
import { CodexClient } from '../src/codex.mjs';

if (process.platform === 'win32') { process.env.SystemRoot ||= 'C:\\Windows'; process.env.WINDIR ||= process.env.SystemRoot; }
const config = await loadConfig();
const state = JSON.parse(await readFile(join(config.stateDir, 'state.json'), 'utf8'));
if (state.jobs.some(job => job.status === 'running')) throw new Error('当前任务尚在运行；跨进程读取的落盘回合状态不能代替实时状态。请等待完成后检查。');
const conversation = Object.values(state.conversations).find(c => c.peerId === state.account?.userId);
if (!conversation?.current) throw new Error('没有微信会话');
const client = new CodexClient({ executable: config.codexPath });
try {
  await client.initialize();
  const { thread } = await client.call('thread/read', { threadId: conversation.current, includeTurns: true });
  console.log(JSON.stringify({ threadId: thread.id, turns: thread.turns.map(t => ({ status: t.status, commandItems: t.items.filter(i => i.type === 'commandExecution').length, approvalMarkerExecuted: t.items.some(i => i.type === 'commandExecution' && i.exitCode === 0 && i.aggregatedOutput?.includes('CODEX_APPROVAL_OK')), fileMarkerRead: t.items.some(i => i.type === 'commandExecution' && i.exitCode === 0 && i.aggregatedOutput?.includes('CODEX_WECHAT_FILE_OK')), assistantMessages: t.items.filter(i => i.type === 'agentMessage').length })), inferenceRequests: 0 }, null, 2));
} finally { client.close(); }
