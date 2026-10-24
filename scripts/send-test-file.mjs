import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../src/cli.mjs';
import { sendFilePath } from '../src/wechat-file.mjs';

if (process.platform === 'win32') { process.env.SystemRoot ||= 'C:\\Windows'; process.env.WINDIR ||= process.env.SystemRoot; }
const config = await loadConfig();
const state = JSON.parse(await readFile(join(config.stateDir, 'state.json'), 'utf8'));
const account = state.account;
if (!account?.userId) throw new Error('微信尚未绑定');
const conversation = Object.values(state.conversations).find(c => c.peerId === account.userId && c.contextToken);
if (!conversation) throw new Error('请先从微信发送一条消息以获取回复令牌');
const directory = join(config.workspace, 'outputs');
await mkdir(directory, { recursive: true });
const fileName = 'codex-wechat-file-test.txt';
const data = Buffer.from('Codex 微信文件回传测试\n\n如果你能在手机上打开此文件，说明文件上传和微信附件发送已打通。\n校验标记：CODEX_WECHAT_FILE_OK\n', 'utf8');
await writeFile(join(directory, fileName), data);
await sendFilePath({ account, to: account.userId, path: join(directory, fileName), contextToken: conversation.contextToken });
console.log(JSON.stringify({ upload: 'accepted', send: 'accepted', fileName, bytes: data.length, recipient: 'bound-user', phoneDownload: 'awaiting-confirmation' }));
