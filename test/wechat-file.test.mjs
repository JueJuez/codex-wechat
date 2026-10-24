import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sendFilePath } from '../src/wechat-file.mjs';
import { decryptAesEcb } from '../vendor/wechat-core/lib/crypto.js';

test('real upload wrapper reads disk file, encrypts it and sends downloadable reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-wechat-upload-'));
  const file = join(directory, 'test.txt'); const original = Buffer.from('微信文件内容'); await writeFile(file, original);
  const originalFetch = globalThis.fetch; let slot; let sent; let ciphertext; let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    if (String(url).includes('getuploadurl')) { slot = JSON.parse(init.body); return new Response(JSON.stringify({ upload_full_url: 'https://cdn.example.invalid/upload' }), { status: 200 }); }
    if (String(url) === 'https://cdn.example.invalid/upload') { ciphertext = Buffer.from(init.body); return new Response('', { status: 200, headers: { 'x-encrypted-param': 'download-reference' } }); }
    if (String(url).includes('sendmessage')) { sent = JSON.parse(init.body); return new Response('{"ret":0}', { status: 200 }); }
    throw new Error('unexpected request');
  };
  try {
    await sendFilePath({ account: { accountId: 'bot', token: 'test', baseUrl: 'https://example.invalid', savedAt: '' }, to: 'owner', path: file, contextToken: 'context' });
    assert.equal(requests, 3); assert.equal(slot.rawsize, original.length);
    assert.deepEqual(decryptAesEcb(ciphertext, Buffer.from(slot.aeskey, 'hex')), original);
    const item = sent.msg.item_list[0].file_item;
    assert.equal(item.file_name, 'test.txt'); assert.equal(item.media.encrypt_query_param, 'download-reference');
    assert.equal(sent.msg.context_token, 'context'); assert.equal(sent.msg.to_user_id, 'owner');
  } finally { globalThis.fetch = originalFetch; }
});
