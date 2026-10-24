import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/cli.mjs';

const config = await loadConfig(); const inbox = join(config.workspace, '.codex-wechat', 'inbox');
let files;
try { files = await readdir(inbox, { recursive: true }); }
catch (e) { if (e.code !== 'ENOENT') throw e; files = []; }
const candidates = files.filter(path => path.endsWith('codex-wechat-file-test.txt'));
if (!candidates.length) { console.log('等待微信入站测试文件'); process.exit(0); }
const hash = data => createHash('sha256').update(data).digest('hex');
const sourceHash = hash(await readFile(join(config.workspace, 'outputs', 'codex-wechat-file-test.txt')));
const results = [];
for (const candidate of candidates) {
  const path = join(inbox, candidate); const data = await readFile(path);
  results.push({ path, bytes: data.length, identical: hash(data) === sourceHash, markerPresent: data.toString('utf8').includes('CODEX_WECHAT_FILE_OK') });
}
console.log(JSON.stringify(results, null, 2));
if (!results.some(r => r.identical)) process.exitCode = 1;
