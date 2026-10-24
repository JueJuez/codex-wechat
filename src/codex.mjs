import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class CodexClient extends EventEmitter {
  constructor({ executable = 'codex', args = ['app-server', '--listen', 'stdio://'] } = {}) {
    super(); this.nextId = 1; this.pending = new Map(); this.closed = false;
    this.proc = spawn(executable, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stderr.on('data', () => {}); // Do not expose tokens or local paths in transport logs.
    this.proc.stdin.on('error', e => this.fail(e));
    this.proc.on('error', e => this.fail(e));
    this.proc.on('exit', (code, signal) => this.fail(new Error(`Codex 进程退出：${code ?? signal}`)));
    createInterface({ input: this.proc.stdout }).on('line', line => {
      try { this.receive(JSON.parse(line)); } catch (e) { this.fail(new Error('Codex 协议异常', { cause: e })); }
    });
  }
  fail(e) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(e); }
    this.pending.clear(); this.emit('disconnected', e);
  }
  receive(msg) {
    if (msg.method) this.emit(msg.id === undefined ? 'notification' : 'request', msg);
    else {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id); clearTimeout(pending.timer);
      if (msg.error) pending.reject(new Error(msg.error.message)); else pending.resolve(msg.result);
    }
  }
  send(msg) { if (this.closed) throw new Error('Codex 未连接'); this.proc.stdin.write(JSON.stringify(msg) + '\n'); }
  call(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex 请求超时：${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  async initialize() {
    await this.call('initialize', { clientInfo: { name: 'codex_wechat', title: 'Codex WeChat', version: '0.1.0' } });
    this.send({ method: 'initialized', params: {} });
  }
  respond(id, result) { this.send({ id, result }); }
  rejectRequest(id) { this.send({ id, error: { code: -32601, message: 'WeChat bridge does not support this request' } }); }
  close() { this.proc.kill(); }
}
