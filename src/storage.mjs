import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export class Storage {
  constructor(file) { this.file = file; this.chain = Promise.resolve(); }
  async load() {
    try { this.data = JSON.parse(await readFile(this.file, 'utf8')); }
    catch (e) {
      if (e.code !== 'ENOENT') throw new Error(`状态文件无法读取，已保留原文件：${this.file}`, { cause: e });
      this.data = { version: 1, conversations: {}, seen: [], jobs: [] };
    }
    if (this.data.version !== 1 || !this.data.conversations || !Array.isArray(this.data.jobs) || !Array.isArray(this.data.seen)) throw new Error('状态结构无效，请先备份检查');
    return this;
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
