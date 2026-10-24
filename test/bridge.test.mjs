import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, readdir, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Bridge, confinedFile } from '../src/bridge.mjs';
import { CodexBackend, ZcodeBackend, resolveCodexExecutable } from '../src/backend.mjs';
import { Storage, acquireLock } from '../src/storage.mjs';
import { loadConfig } from '../src/cli.mjs';

const tick = () => new Promise(r => setTimeout(r, 10));
async function until(predicate) { for (let i = 0; i < 500; i++) { if (predicate()) return; await tick(); } throw new Error('test timeout'); }
const message = (text, id = text) => ({ accountId: 'bot', conversationId: 'bot:owner', peerId: 'owner', messageId: id, contextToken: 'ctx', text });

const FAKE_ZCODE = `const args = process.argv.slice(2);
console.log('zcode fake start');
console.log('sess_fake-' + (args.includes('--resume') ? 'resumed' : 'fresh'));
console.log('args ' + JSON.stringify(args));
console.log('zcode fake done');`;
const SLOW_ZCODE = `setTimeout(() => { console.log('slow done'); }, 8000);`;

async function fixture({ zcodeScript = FAKE_ZCODE, withZcode = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-test-'));
  const wsCodex = join(dir, 'ws-codex'); await mkdir(wsCodex);
  const store = await new Storage(join(dir, 'state.json')).load(); store.data.account = { userId: 'owner' };
  const codex = new EventEmitter(); codex.calls = []; codex.responses = []; let seq = 0;
  codex.call = async (method, params) => {
    codex.calls.push({ method, params });
    if (method === 'thread/start') return { thread: { id: 'thread-' + ++seq } };
    if (method === 'turn/start') return { turn: { id: 'turn-' + seq } };
    return {};
  };
  codex.respond = (id, result) => codex.responses.push({ id, result });
  codex.rejectRequest = id => codex.responses.push({ id, rejected: true });
  const backends = new Map();
  backends.set('codex', new CodexBackend({ id: 'codex', workspace: wsCodex, permissionMode: 'workspace', client: codex }));
  if (withZcode) {
    const wsZcode = join(dir, 'ws-zcode'); await mkdir(wsZcode);
    const cli = join(dir, 'fake-zcode.cjs');
    await writeFile(cli, zcodeScript);
    backends.set('zcode', new ZcodeBackend({ id: 'zcode', workspace: wsZcode, node: process.execPath, cli }));
  }
  const output = [];
  const bridge = new Bridge({ backends, store, config: { defaultAgent: 'codex', maxReplyChars: 3000 }, sendText: async (m, text) => output.push(text), sendFile: async () => {}, downloadMedia: async () => {}, log: () => {} });
  return { dir, bridge, store, codex, output, backends, wsCodex };
}
function complete(codex, threadId = 'thread-1', status = 'completed') {
  codex.emit('notification', { method: 'item/completed', params: { threadId, item: { id: 'answer', type: 'agentMessage', text: '真实结果' } } });
  codex.emit('notification', { method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status } } });
}

test('only bound owner may execute; duplicate delivery runs one turn', async () => {
  const { bridge, codex } = await fixture();
  await bridge.accept({ ...message('bad'), peerId: 'stranger' });
  await bridge.accept({ ...message('bad2'), groupId: 'group' });
  assert.equal(codex.calls.length, 0);
  await bridge.accept(message('任务', 'same')); await bridge.accept(message('任务', 'same'));
  await until(() => codex.calls.some(c => c.method === 'turn/start'));
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(codex.calls.find(c => c.method === 'thread/start').params.sandbox, 'workspace-write');
  complete(codex); await until(() => !bridge.backends.get('codex').working);
});

test('task without prefix goes to default backend and reply carries platform prefix', async () => {
  const { bridge, codex, output, store } = await fixture();
  await bridge.accept(message('任务', 'm1'));
  await until(() => codex.calls.some(c => c.method === 'turn/start'));
  const job = store.data.jobs.find(j => j.agent === 'codex');
  assert.equal(store.data.jobs[0].agent, 'codex');
  complete(codex); await until(() => !bridge.backends.get('codex').working);
  assert.ok(output.some(s => s.startsWith('[codex] 已收到，codex 开始处理')));
  assert.ok(output.some(s => s.startsWith('[codex] 真实结果')));
});

test('unknown @backend answers with available list and enqueues nothing', async () => {
  const { bridge, codex, output, store } = await fixture();
  await bridge.accept(message('@nope 任务', 'm1'));
  await until(() => output.some(s => s.includes('未知后端 @nope')));
  assert.ok(output.some(s => s.includes('@codex') && s.includes('@zcode')));
  assert.equal(store.data.jobs.length, 0);
  assert.equal(codex.calls.length, 0);
  await bridge.accept(message('@codex', 'm2'));
  await until(() => output.some(s => s.includes('后写任务内容')));
  assert.equal(store.data.jobs.length, 0);
});

test('@zcode routes to zcode backend; session id parsed then passed via --resume', async () => {
  const { bridge, codex, output, store } = await fixture();
  await bridge.accept(message('@zcode 查看目录', 'z1'));
  await until(() => output.filter(s => s.includes('zcode fake done')).length >= 1);
  assert.ok(output.some(s => s.startsWith('[zcode] ')));
  const conv = store.data.conversations['bot:owner'];
  const session = conv.sessions.zcode[0];
  assert.equal(session.id, 'sess_fake-fresh');
  assert.equal(conv.current.zcode, session.ref);
  assert.equal(codex.calls.length, 0);
  await bridge.accept(message('@zcode 再来一次', 'z2'));
  await until(() => output.filter(s => s.includes('zcode fake done')).length >= 2);
  const argsText = output.find(s => s.includes('--resume'));
  assert.ok(argsText.includes('"--resume","sess_fake-fresh"'));
  assert.ok(argsText.includes('"--mode","yolo"'));
});

test('/use sets per-conversation default backend and unprefixed tasks follow it', async () => {
  const { bridge, codex, output, store } = await fixture();
  await bridge.accept(message('/use zcode'));
  await until(() => output.some(s => s.includes('默认后端已设为 zcode')));
  assert.equal(store.data.conversations['bot:owner'].defaultAgent, 'zcode');
  await bridge.accept(message('无前缀任务', 'm1'));
  await until(() => store.data.jobs.some(j => j.agent === 'zcode' && j.status === 'running'));
  await until(() => output.filter(s => s.includes('zcode fake done')).length >= 1);
  assert.equal(codex.calls.length, 0);
});

test('approval ids are namespaced per backend and scoped to conversation', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('执行')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.backends.get('codex').request({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'safe-command', availableDecisions: ['accept', 'decline'] } });
  assert.ok(output.some(s => s.includes('safe-command') && s.includes('/approve c1')));
  await assert.rejects(bridge.command({ ...message('/approve c1'), conversationId: 'other' }), /编号/);
  await bridge.accept(message('/approve 1'));
  await until(() => output.some(s => s.includes('形如 c1')));
  await bridge.accept(message('/approve c1'));
  assert.deepEqual(codex.responses[0], { id: 900, result: { decision: 'accept' } });
  complete(codex); await until(() => !bridge.backends.get('codex').working);
});

test('approval id letter selects the right backend namespace', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('执行')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.backends.get('codex').request({ id: 901, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'cmd-x', availableDecisions: ['accept', 'decline'] } });
  // z 前缀属于 zcode，zcode 没有这个编号 → 拒绝；c 前缀命中 codex。
  await bridge.accept(message('/approve z1'));
  await until(() => output.filter(s => s.includes('形如 c1')).length >= 1);
  await bridge.accept(message('/approve c1'));
  assert.deepEqual(codex.responses[0], { id: 901, result: { decision: 'accept' } });
  complete(codex); await until(() => !bridge.backends.get('codex').working);
});

test('file modification approval includes proposed diff', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('修改')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  codex.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', item: { id: 'patch', type: 'fileChange', changes: [{ path: 'file.txt', diff: '-old\n+new' }] } } });
  await bridge.backends.get('codex').request({ id: 902, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'patch' } });
  assert.ok(output.some(s => s.includes('file.txt') && s.includes('+new')));
  await bridge.accept(message('/deny c1')); complete(codex); await until(() => !bridge.backends.get('codex').working);
});

test('backends run in parallel; /cancel zcode leaves codex untouched', async () => {
  const { bridge, codex, output, store } = await fixture({ zcodeScript: SLOW_ZCODE });
  await bridge.accept(message('codex 任务', 'c1')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.accept(message('@zcode 慢任务', 'z1'));
  await until(() => !!bridge.backends.get('zcode').current);
  assert.ok(bridge.backends.get('codex').working, 'codex 应仍在执行');
  assert.ok(store.data.jobs.some(j => j.agent === 'zcode' && j.status === 'running'));
  await bridge.accept(message('/cancel zcode', 'z2'));
  await until(() => output.some(s => s.includes('任务已停止')));
  await until(() => !bridge.backends.get('zcode').current);
  assert.ok(codex.calls.some(c => c.method === 'turn/start') && !codex.calls.some(c => c.method === 'turn/interrupt'));
  complete(codex, 'thread-1', 'completed');
  await until(() => !bridge.backends.get('codex').working);
  assert.ok(output.some(s => s.startsWith('[codex] 真实结果')));
});

test('/cancel without argument stops every backend', async () => {
  const { bridge, codex, output } = await fixture({ zcodeScript: SLOW_ZCODE });
  await bridge.accept(message('codex 任务', 'c1')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.accept(message('@zcode 慢任务', 'z1')); await until(() => !!bridge.backends.get('zcode').current);
  await bridge.accept(message('/cancel', 'z2'));
  await until(() => !bridge.backends.get('zcode').current);
  assert.ok(codex.calls.some(c => c.method === 'turn/interrupt'));
  complete(codex, 'thread-1', 'interrupted'); await until(() => !bridge.backends.get('codex').working);
  assert.ok(output.some(s => s.includes('已请求停止所有后端任务')));
});

test('/status lists every backend with queue and approval counts', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('/status', 's0'));
  await until(() => output.some(s => s.includes('[codex]') || s.includes('codex 已连接')));
  const text = output.join('\n');
  assert.ok(text.includes('codex 已连接'));
  assert.ok(text.includes('zcode'));
  assert.ok(text.includes('工作区'));
});

test('/list groups by backend; /switch supports backend argument', async () => {
  const { bridge, codex, output, store } = await fixture();
  store.data.conversations['bot:owner'] = {
    peerId: 'owner', defaultAgent: 'codex',
    sessions: {
      codex: [{ ref: 'thread-1', id: 'thread-1', title: '旧会话' }],
      zcode: [{ ref: 'u1', id: 'sess_a', title: 'z 会话' }]
    },
    current: { codex: 'thread-1', zcode: 'u1' }
  };
  await bridge.accept(message('/list', 'l1'));
  await until(() => output.some(s => s.includes('[zcode]')));
  const text = output.join('\n');
  assert.ok(text.includes('[codex]') && text.includes('旧会话') && text.includes('z 会话'));
  await bridge.accept(message('/switch zcode 1', 'l2'));
  await until(() => output.some(s => s.includes('已切换（zcode）')));
  await bridge.accept(message('/switch 1', 'l3'));
  await until(() => output.some(s => s.includes('已切换（codex）')));
});

test('restart marks running work uncertain and does not execute it again', async () => {
  const { bridge, store, codex, output } = await fixture();
  store.data.jobs.push({ id: 'interrupted', status: 'running', agent: 'codex', message: message('写文件') });
  await bridge.recover();
  assert.equal(codex.calls.length, 0); assert.equal(store.data.jobs.length, 0);
  assert.ok(output.some(s => s.includes('结果未知')));
});

test('resume persisted thread; early completion event is not lost', async () => {
  const { bridge, codex, output, store } = await fixture({ withZcode: false });
  store.data.conversations['bot:owner'] = { peerId: 'owner', defaultAgent: null, sessions: { codex: [{ ref: 'thread-1', id: 'thread-1', title: 'saved' }] }, current: { codex: 'thread-1' } };
  const call = codex.call;
  codex.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'turn/start') complete(codex);
    return result;
  };
  await bridge.accept(message('继续')); await until(() => !bridge.backends.get('codex').working);
  assert.ok(codex.calls.some(c => c.method === 'thread/resume'));
  assert.ok(output.some(s => s.includes('真实结果')));
});

test('disconnect ends the active task without success claim', async () => {
  const { bridge, codex, output } = await fixture({ withZcode: false });
  await bridge.accept(message('任务')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  codex.emit('disconnected', new Error('test disconnect')); await until(() => !bridge.backends.get('codex').working);
  assert.ok(output.some(s => s.includes('任务失败')));
});

test('cancel during attachment preparation prevents starting a turn', async () => {
  const { bridge, codex } = await fixture({ withZcode: false });
  let resolveMedia; bridge.backends.get('codex').downloadMedia = () => new Promise(r => { resolveMedia = r; });
  await bridge.accept({ ...message('附件任务'), media: [{}] });
  await until(() => !!resolveMedia);
  await bridge.accept(message('/cancel'));
  resolveMedia({ fileName: '../escaped.txt', kind: 'file', data: Buffer.from('safe') });
  await until(() => !bridge.backends.get('codex').working);
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 0);
});

test('failed durable acceptance rolls back dedup so redelivery is accepted', async () => {
  const { bridge, codex, store } = await fixture({ withZcode: false });
  const save = store.save.bind(store); store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(bridge.accept(message('task', 'retry-id')), /disk full/);
  assert.equal(store.data.seen.length, 0); assert.equal(store.data.jobs.length, 0);
  store.save = save; await bridge.accept(message('task', 'retry-id'));
  await until(() => codex.calls.some(c => c.method === 'turn/start')); complete(codex); await until(() => !bridge.backends.get('codex').working);
});

test('v1 state migrates to per-backend domains with a backup file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-migrate-')); const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({
    version: 1,
    conversations: { 'bot:owner': { peerId: 'owner', sessions: [{ id: 'thread-9', title: '旧会话', createdAt: '2026-01-01T00:00:00.000Z' }], current: 'thread-9' } },
    seen: ['k1'],
    jobs: [{ id: 'j1', status: 'pending', message: { text: '旧任务', conversationId: 'bot:owner', peerId: 'owner' } }]
  }, null, 2));
  const store = await new Storage(path).load();
  assert.equal(store.data.schemaVersion, 2);
  const conv = store.data.conversations['bot:owner'];
  assert.equal(conv.sessions.codex.length, 1);
  assert.equal(conv.sessions.codex[0].id, 'thread-9');
  assert.equal(conv.sessions.codex[0].ref, 'thread-9');
  assert.equal(conv.current.codex, 'thread-9');
  assert.equal(store.data.jobs[0].agent, 'codex');
  assert.ok((await readdir(dir)).some(f => f.startsWith('state.json.bak-')));
  await store.save();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 2);
});

test('legacy single-backend config maps to one codex agent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-cfg-')); const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify({ workspace: 'D:/tmp/legacy-ws', codexPath: 'C:/tools/codex.exe', permissionMode: 'workspace', model: null, maxReplyChars: 3000 }));
  const config = await loadConfig(path);
  assert.deepEqual(Object.keys(config.agents), ['codex']);
  assert.equal(config.agents.codex.adapter, 'codex-app-server');
  assert.equal(config.agents.codex.executable, 'C:/tools/codex.exe');
  assert.equal(config.agents.codex.workspace, resolve('D:/tmp/legacy-ws'));
  assert.equal(config.defaultAgent, 'codex');
});

test('new agents config: shared workspace is rejected unless explicitly allowed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-cfg2-')); const path = join(dir, 'config.json');
  const base = { defaultAgent: 'codex', agents: {
    codex: { adapter: 'codex-app-server', workspace: 'D:/tmp/same', permissionMode: 'workspace' },
    zcode: { adapter: 'zcode-headless', cli: 'D:/AI/ZCode/resources/glm/zcode.cjs', workspace: 'D:/tmp/same', mode: 'yolo' }
  } };
  await writeFile(path, JSON.stringify(base));
  await assert.rejects(loadConfig(path), /工作区相同/);
  await writeFile(path, JSON.stringify({ ...base, allowSharedWorkspace: true }));
  const config = await loadConfig(path);
  assert.ok(config.sharedWorkspaceWarning.includes('共享工作区'));
});

test('new agents config: duplicate id initials and unknown adapters are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-cfg3-')); const path = join(dir, 'config.json');
  const base = { agents: {
    codex: { adapter: 'codex-app-server', workspace: 'D:/tmp/a' },
    claude: { adapter: 'codex-app-server', workspace: 'D:/tmp/b' }
  } };
  await writeFile(path, JSON.stringify(base));
  await assert.rejects(loadConfig(path), /首字母重复/);
  await writeFile(path, JSON.stringify({ agents: { foo: { adapter: 'mystery', workspace: 'D:/tmp/a' } } }));
  await assert.rejects(loadConfig(path), /adapter/);
  await writeFile(path, JSON.stringify({ agents: { zcode: { adapter: 'zcode-headless', workspace: 'D:/tmp/a' } } }));
  await assert.rejects(loadConfig(path), /cli 必填/);
});

test('codex executable resolution: explicit missing path fails, existing path passes', async () => {
  await assert.rejects(resolveCodexExecutable('D:/definitely/not/here/codex.exe'), /不存在/);
  assert.equal(await resolveCodexExecutable(process.execPath), process.execPath);
});

test('malformed state is preserved and rejected; concurrent writes preserve final snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-store-')); const path = join(dir, 'state.json');
  await writeFile(path, '{broken'); await assert.rejects(new Storage(path).load(), /保留/);
  assert.equal(await readFile(path, 'utf8'), '{broken');
  const store = await new Storage(join(dir, 'valid.json')).load();
  store.data.seen.push('one'); const first = store.save(); store.data.seen.push('two'); await Promise.all([first, store.save()]);
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).seen, ['one', 'two']);
});

test('single process lock blocks second bridge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-lock-')); const path = join(dir, 'lock');
  const release = await acquireLock(path); await assert.rejects(acquireLock(path), /已运行/); await release();
  const next = await acquireLock(path); await next();
});

test('file return forbids traversal and symlink escape', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-files-')); const root = join(dir, 'workspace'); await mkdir(root);
  await writeFile(join(root, 'ok.txt'), 'ok'); await writeFile(join(dir, 'private.txt'), 'private');
  assert.equal(await confinedFile(root, 'ok.txt'), join(root, 'ok.txt'));
  await assert.rejects(confinedFile(root, '../private.txt'), /只能/);
  await symlink(dir, join(root, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(confinedFile(root, 'external/private.txt'), /只能/);
});

test('invalid chunk limit fails before a send loop can hang', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-config-')); const path = join(dir, 'config.json');
  await writeFile(path, '{"maxReplyChars":0}'); await assert.rejects(loadConfig(path), /maxReplyChars/);
});
