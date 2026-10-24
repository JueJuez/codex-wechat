// 桌面端任务 → 微信通知。桌面会话里执行：
//   node scripts/notify.mjs "任务完成：XXX" [--session sess_xxx] [--engine zcode] [--dry]
// 自动识别：默认取 ZCode 会话库中「当前 cwd 最近活跃的 interactive 会话」作为会话 id，
// 项目名从 config.json 的 projects 按 workspace 反查，拼出可直接回复的 /adopt 命令。
// 用法见 --help。发微信依赖已绑定的账号与 contextToken（state.json）。
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../src/cli.mjs';
import { sendText } from '../vendor/wechat-core/lib/index.js';

const HELP = `用法：node scripts/notify.mjs <消息文本> [--session 会话id] [--engine 引擎] [--dry]
  --session  显式指定会话 id；缺省自动识别（当前 cwd 最近活跃的 interactive 会话）
  --engine   /adopt 建议命令里的引擎，默认 zcode
  --dry      只打印将要发送的内容，不发微信`;

const norm = p => resolve(p).replaceAll('\\', '/').toLowerCase();
const ZCODE_DB = process.env.ZCODE_DB ?? `${homedir()}/.zcode/cli/db/db.sqlite`.replaceAll('\\', '/');

async function detectSession(cwd) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(ZCODE_DB, { readOnly: true });
  try {
    // directory 在库里是原始分隔符写法，等值比较需在 JS 侧归一化。
    const rows = db.prepare(
      "select id, title, directory from session where task_type = 'interactive' and time_deleted is null order by time_updated desc limit 500"
    ).all();
    return rows.find(r => norm(r.directory) === norm(cwd)) ?? null;
  } finally { db.close(); }
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { console.log(HELP); process.exit(0); }
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const text = args.filter((a, i) => !['--session', '--engine'].includes(args[i - 1]) && !a.startsWith('--')).join(' ').trim();
if (!text) { console.error('缺少消息文本。\n' + HELP); process.exit(1); }
const engine = flag('--engine', 'zcode');
const dry = args.includes('--dry');

const config = await loadConfig();
const state = JSON.parse(await readFile(new URL(`file:///${config.stateDir.replaceAll('\\', '/')}/state.json`), 'utf8'));
const account = state.account;
if (!account?.userId) throw new Error('微信尚未绑定（先 npm run login）');
const conversation = Object.values(state.conversations).find(c => c.peerId === account.userId && c.contextToken);
if (!conversation) throw new Error('没有可用的回复令牌（先从微信发一条消息）');

const cwd = process.cwd();
const session = flag('--session') ?? await detectSession(norm(cwd));
if (!session) throw new Error(`会话库 ${ZCODE_DB} 中找不到 cwd 的会话（可先在桌面端发一句话再试，或用 --session 指定）`);
const projectId = Object.entries(config.projects ?? {}).find(([, p]) => norm(p.workspace) === norm(cwd))?.[0];
const adoptHint = projectId ? `回复 /adopt ${engine}/${projectId} ${session.id} 续接该会话` : `回复 /adopt ${engine} <项目> ${session.id} 续接（cwd 未注册为项目）`;
const body = `[桌面任务通知]\n${text}\n会话：${session.id}（${session.title ?? '无标题'}）\n${adoptHint}`;

if (dry) {
  console.log(JSON.stringify({ dry: true, to: account.userId, bytes: Buffer.byteLength(body), body }, null, 2));
  process.exit(0);
}
await sendText({ account, to: account.userId, text: body, contextToken: conversation.contextToken });
console.log(JSON.stringify({ sent: true, session: session.id, project: projectId ?? null, chars: Array.from(body).length }));
