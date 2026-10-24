import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeStatus, requestStop, watchStop } from '../src/lifecycle.mjs';

test('runtime status hides account credentials; stop request targets owned PID', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-runtime-'));
  await writeFile(join(dir, 'state.json'), JSON.stringify({ account: { userId: 'owner', token: 'never-show' }, jobs: [], seen: ['one'] }));
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ pid: process.pid, status: 'running' }));
  const status = await runtimeStatus(dir); assert.equal(status.running, true); assert.equal(status.bound, true); assert.ok(!JSON.stringify(status).includes('never-show'));
  let stopped; const done = new Promise(r => { stopped = r; });
  const close = await watchStop(dir, stopped, assert.fail);
  try { await requestStop(dir); assert.equal(JSON.parse(await readFile(join(dir, 'stop.request'), 'utf8')).pid, process.pid); await done; }
  finally { close(); }
});
