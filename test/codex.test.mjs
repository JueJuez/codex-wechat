import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexClient } from '../src/codex.mjs';
test('JSONL subprocess transport matches responses and routes server requests', async () => {
  const program = `const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',l=>{const m=JSON.parse(l);if(m.method==='initialize'){console.log(JSON.stringify({id:m.id,result:{}}));}else if(m.method==='echo'){console.log(JSON.stringify({id:777,method:'approval',params:{}}));console.log(JSON.stringify({id:m.id,result:m.params}));}})`;
  const client = new CodexClient({ executable: process.execPath, args: ['-e', program] });
  let request; client.on('request', m => { request = m; });
  try { await client.initialize(); assert.deepEqual(await client.call('echo', { text: '中文\n换行' }), { text: '中文\n换行' }); assert.equal(request.id, 777); }
  finally { client.close(); }
});
test('unexpected process exit rejects pending RPC rather than hanging', async () => {
  const client = new CodexClient({ executable: process.execPath, args: ['-e', 'process.exit(2)'] });
  await assert.rejects(client.initialize(), /退出/);
});
