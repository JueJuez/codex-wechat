import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export const SCHEMA_VERSION = 3;

export class Storage {
  constructor(file) { this.file = file; this.chain = Promise.resolve(); }
  async load() {
    let existed = true;
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`状态文件无法读取，已保留原文件：${this.file}`, { cause: e });
      existed = false;
      this.data = { schemaVersion: SCHEMA_VERSION, conversations: {}, seen: [], jobs: [] };
    }
    if (existed && this.data.schemaVersion !== SCHEMA_VERSION) await this.migrate();
    this.validate();
    return this;
  }
  validate() {
    const d = this.data;
    if (d.schemaVersion !== SCHEMA_VERSION) throw new Error(`状态 schemaVersion ${d.schemaVersion ?? d.version} 不受支持，请先备份检查`);
    if (!d.conversations || typeof d.conversations !== 'object' || Array.isArray(d.conversations) || !Array.isArray(d.jobs) || !Array.isArray(d.seen)) throw new Error('状态结构无效，请先备份检查');
  }
  // v1（单 Codex）→ v2（按后端分域）→ v3（引擎/项目复合键）。迁移前落一份备份；改动原子写盘，失败不破坏原文件。
  async migrate() {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    await writeFile(`${this.file}.bak-${stamp}`, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    if (this.data.version === 1) {
      for (const conv of Object.values(this.data.conversations)) {
        if (Array.isArray(conv.sessions)) conv.sessions = { codex: conv.sessions.map(s => ({ ...s, ref: s.ref || s.id })) };
        if (!conv.sessions || typeof conv.sessions !== 'object' || Array.isArray(conv.sessions)) conv.sessions = {};
        conv.current = typeof conv.current === 'string' ? { codex: conv.current } : (conv.current && typeof conv.current === 'object' ? conv.current : {});
        conv.defaultAgent ??= null;
      }
      for (const job of this.data.jobs) job.agent ??= 'codex';
      delete this.data.version;
      this.data.schemaVersion = 2;
    }
    if (this.data.schemaVersion === 2) {
      // 一期键是纯引擎 id；其配置形态等价于「每引擎一个同名项目」，故映射为 `引擎/引擎`。
      for (const conv of Object.values(this.data.conversations)) {
        const remap = obj => Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [k.includes('/') ? k : `${k}/${k}`, v]));
        conv.sessions = remap(conv.sessions);
        conv.current = remap(conv.current);
        conv.currentProject ??= null;
      }
      for (const job of this.data.jobs) job.project ??= job.agent;
      this.data.schemaVersion = SCHEMA_VERSION;
    }
    if (this.data.schemaVersion !== SCHEMA_VERSION) throw new Error(`状态 schemaVersion ${this.data.schemaVersion ?? this.data.version} 不受支持，请先备份检查`);
    await this.save();
  }
  save() {
    const snapshot = JSON.stringify(this.data, null, 2) + '\n';
    const write = this.chain.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.chain = write;
    return write;
  }
}

export async function acquireLock(file) {
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(file, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await unlink(file); };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(await readFile(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('锁文件损坏，请人工检查');
      try { process.kill(pid, 0); }
      catch (probe) { if (probe.code === 'ESRCH') { await unlink(file); continue; } throw probe; }
      throw new Error(`桥接或登录进程已运行（PID ${pid}），请先停止它`);
    }
  }
  throw new Error('无法取得运行锁');
}
