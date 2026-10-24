import { readFile, writeFile, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function runtimeStatus(stateDir) {
  const readJson = async file => { try { return JSON.parse(await readFile(join(stateDir, file), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  const state = await readJson('state.json'); const runtime = await readJson('runtime.json');
  let running = false;
  if (runtime) { try { process.kill(runtime.pid, 0); running = runtime.status === 'running'; } catch {} }
  return { running, pid: running ? runtime.pid : null, bound: !!state?.account?.userId, pendingJobs: state?.jobs?.length || 0, receivedMessages: state?.seen?.length || 0, startedAt: runtime?.startedAt || null, heartbeatAt: runtime?.heartbeatAt || null, stateDir };
}

export async function launchBackground(stateDir, cwd) {
  const status = await runtimeStatus(stateDir);
  if (status.running) throw new Error(`桥接已在运行，PID ${status.pid}`);
  const output = await open(join(stateDir, 'runtime.out.log'), 'a', 0o600);
  const errors = await open(join(stateDir, 'runtime.err.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'start'], {
      cwd, detached: true, windowsHide: true, stdio: ['ignore', output.fd, errors.fd], env: process.env
    });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    for (let attempt = 0; attempt < 100; attempt++) {
      const current = await runtimeStatus(stateDir);
      if (current.running && current.pid === child.pid) return child.pid;
      if (child.exitCode !== null) throw new Error('后台启动失败，请查看 runtime.err.log');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    child.kill(); throw new Error('后台启动未在 10 秒内就绪，请查看 runtime.err.log');
  } finally { await output.close(); await errors.close(); }
}

export async function requestStop(stateDir) {
  const status = await runtimeStatus(stateDir);
  if (!status.running) throw new Error('桥接未运行');
  await writeFile(join(stateDir, 'stop.request'), JSON.stringify({ pid: status.pid }), { mode: 0o600 });
}

export async function watchStop(stateDir, stop, report) {
  await rm(join(stateDir, 'stop.request'), { force: true });
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
      let request;
      try { request = JSON.parse(await readFile(join(stateDir, 'stop.request'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') report(e.message); }
      if (request?.pid === process.pid) { await rm(join(stateDir, 'stop.request'), { force: true }); stop(); }
    } finally { busy = false; }
  }, 1000);
  return () => clearInterval(timer);
}
