import test from 'node:test';
import assert from 'node:assert/strict';
import { ChannelMonitor } from '../vendor/wechat-core/lib/channel.js';
test('cursor commits after durable inbox acceptance; failed dispatch leaves cursor unchanged', async () => {
  const original = globalThis.fetch;
  try {
    const order = []; const controller = new AbortController();
    globalThis.fetch = async () => new Response(JSON.stringify({ ret: 0, get_updates_buf: 'next', msgs: [{ from_user_id: 'owner', message_type: 1, message_id: '1', item_list: [{ type: 1, text_item: { text: 'task' } }] }] }), { status: 200 });
    const account = { accountId: 'bot', token: 'test', baseUrl: 'https://example.invalid' };
    const monitor = new ChannelMonitor({ account, onMessage: async () => { order.push('inbox'); controller.abort(); }, onSyncBuf: async () => { order.push('cursor'); } });
    await monitor.run(controller.signal); assert.deepEqual(order, ['inbox', 'cursor']);
    const abort = new AbortController();
    const failure = new ChannelMonitor({ account, initialSyncBuf: 'old', onMessage: async () => { abort.abort(); throw new Error('disk full'); }, onSyncBuf: () => assert.fail('must not advance') });
    await failure.run(abort.signal); assert.equal(failure.syncBuf, 'old');
  } finally { globalThis.fetch = original; }
});
test('five authentication failures stop instead of polling forever', async () => {
  const original = globalThis.fetch; let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; return new Response('unauthorized', { status: 401 }); };
    const monitor = new ChannelMonitor({ account: { accountId: 'bot', token: 'test', baseUrl: 'https://example.invalid' }, onMessage: async () => {}, sleep: async () => {} });
    assert.equal(await monitor.run(new AbortController().signal), 'fatal'); assert.equal(sent, 5);
  } finally { globalThis.fetch = original; }
});
test('five protocol errors stop with no unbounded retries', async () => {
  const original = globalThis.fetch; let sent = 0;
  try {
    globalThis.fetch = async () => { sent++; return new Response(JSON.stringify({ ret: -2, errmsg: 'invalid' }), { status: 200 }); };
    const monitor = new ChannelMonitor({ account: { accountId: 'bot', token: 'test', baseUrl: 'https://example.invalid' }, onMessage: async () => {}, sleep: async () => {} });
    assert.equal(await monitor.run(new AbortController().signal), 'fatal'); assert.equal(sent, 5);
  } finally { globalThis.fetch = original; }
});
