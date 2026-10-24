import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, readFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge, confinedFile } from '../src/bridge.mjs';
import { Storage, acquireLock } from '../src/storage.mjs';
import { loadConfig } from '../src/cli.mjs';

const tick = () => new Promise(r => setTimeout(r, 10));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error('test timeout'); }
const message = (text, id = text) => ({ accountId: 'bot', conversationId: 'bot:owner', peerId: 'owner', messageId: id, contextToken: 'ctx', text });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-wechat-test-'));
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
  const output = [];
  const bridge = new Bridge({ codex, store, config: { workspace: dir, permissionMode: 'workspace', maxReplyChars: 3000 }, sendText: async (m, text) => output.push(text), sendFile: async () => {}, downloadMedia: async () => {}, log: () => {} });
  return { dir, bridge, store, codex, output };
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
  complete(codex); await until(() => !bridge.working);
});
test('approval remains reachable while a turn is running; approval is scoped to conversation', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('执行')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.request({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'safe-command', availableDecisions: ['accept', 'decline'] } });
  assert.ok(output.some(s => s.includes('safe-command')));
  await assert.rejects(bridge.command({ ...message('/approve 1'), conversationId: 'other' }), /编号/);
  await bridge.accept(message('/approve 1'));
  assert.deepEqual(codex.responses[0], { id: 900, result: { decision: 'accept' } });
  complete(codex); await until(() => !bridge.working);
});
test('cancel interrupts active turn and clears queued work without starting it', async () => {
  const { bridge, codex, store } = await fixture();
  await bridge.accept(message('任务1')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  await bridge.accept(message('任务2'));
  await bridge.accept(message('/cancel'));
  assert.ok(codex.calls.some(c => c.method === 'turn/interrupt'));
  complete(codex, 'thread-1', 'interrupted'); await until(() => !bridge.working);
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.equal(store.data.jobs.length, 0);
});
test('restart marks running work uncertain and does not execute it again', async () => {
  const { bridge, store, codex, output } = await fixture();
  store.data.jobs.push({ id: 'interrupted', status: 'running', message: message('写文件') });
  await bridge.recover();
  assert.equal(codex.calls.length, 0); assert.equal(store.data.jobs.length, 0);
  assert.ok(output.some(s => s.includes('结果未知')));
});
test('resume persisted thread; early completion event is not lost', async () => {
  const { bridge, store, codex, output } = await fixture();
  store.data.conversations['bot:owner'] = { peerId: 'owner', current: 'thread-1', sessions: [{ id: 'thread-1', title: 'saved' }] };
  const call = codex.call;
  codex.call = async (method, params) => {
    const result = await call(method, params);
    if (method === 'turn/start') complete(codex);
    return result;
  };
  await bridge.accept(message('继续')); await until(() => !bridge.working);
  assert.ok(codex.calls.some(c => c.method === 'thread/resume'));
  assert.ok(output.includes('真实结果'));
});
test('file modification approval includes proposed diff', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('修改')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  codex.emit('notification', { method: 'item/started', params: { threadId: 'thread-1', item: { id: 'patch', type: 'fileChange', changes: [{ path: 'file.txt', diff: '-old\n+new' }] } } });
  await bridge.request({ id: 901, method: 'item/fileChange/requestApproval', params: { threadId: 'thread-1', itemId: 'patch' } });
  assert.ok(output.some(s => s.includes('file.txt') && s.includes('+new')));
  await bridge.accept(message('/deny 1')); complete(codex); await until(() => !bridge.working);
});
test('disconnect ends the active task without success claim', async () => {
  const { bridge, codex, output } = await fixture();
  await bridge.accept(message('任务')); await until(() => codex.calls.some(c => c.method === 'turn/start'));
  codex.emit('disconnected', new Error('test disconnect')); await until(() => !bridge.working);
  assert.ok(output.some(s => s.includes('任务失败')));
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
test('failed durable acceptance rolls back dedup so redelivery is accepted', async () => {
  const { bridge, store, codex } = await fixture();
  const save = store.save.bind(store); store.save = async () => { throw new Error('disk full'); };
  await assert.rejects(bridge.accept(message('task', 'retry-id')), /disk full/);
  assert.equal(store.data.seen.length, 0); assert.equal(store.data.jobs.length, 0);
  store.save = save; await bridge.accept(message('task', 'retry-id'));
  await until(() => codex.calls.some(c => c.method === 'turn/start')); complete(codex); await until(() => !bridge.working);
});
test('cancel during attachment preparation prevents starting a turn', async () => {
  const { bridge, codex } = await fixture();
  let resolveMedia; bridge.downloadMedia = () => new Promise(r => { resolveMedia = r; });
  await bridge.accept({ ...message('附件任务'), media: [{}] });
  await until(() => !!resolveMedia);
  await bridge.accept(message('/cancel'));
  resolveMedia({ fileName: '../escaped.txt', kind: 'file', data: Buffer.from('safe') });
  await until(() => !bridge.working);
  assert.equal(codex.calls.filter(c => c.method === 'turn/start').length, 0);
});
