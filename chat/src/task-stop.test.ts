import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { transpileModule, ScriptTarget, ModuleKind } from 'typescript';
import { expect, it } from 'vitest';

const main = transpileModule(readFileSync(new URL('./task-stop.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace('export function', 'function'), {
  compilerOptions: { target: ScriptTarget.ES2022, module: ModuleKind.ES2022 },
}).outputText;

const modes = ['failure', 'later-failure', 'deadline', 'success', 'deadline-late-success', 'success-before-deadline'] as const;
for (const mode of modes) {
  it(`flushes the task-stop ${mode} log before exiting with a backpressured pipe`, async () => {
    const failed = "Promise.reject(new Error('sleep failed control'))";
    const sleep = {
      failure: `{slept:${failed},sleeps:[]}`,
      // The first failure is logged at once; the task exits only once the other browsers have slept, logging a later failure too.
      'later-failure': `(()=>{const first=${failed};
        const later=new Promise((_,reject)=>setTimeout(()=>reject(new Error('later sleep failed')),300));
        return {slept:first,sleeps:[first,later]};})()`,
      deadline: '{slept:new Promise(() => {}),sleeps:[]}',
      success: "{slept:Promise.resolve(['browser-proven']),sleeps:[]}",
      'success-before-deadline': "{slept:Promise.resolve(['browser-proven']),sleeps:[]}",
      'deadline-late-success': "{slept:new Promise(resolve=>setTimeout(()=>resolve(['browser-after-deadline']),50)),sleeps:[]}",
    }[mode];
    // Only the Agent Computers are substituted: the real handler takes the real SIGTERM
    // and exits the real child process, against an actual blocked pipe.
    const boundary = `sleepComputersAtTaskStop(()=>(${sleep})); setInterval(()=>{},1000);`;
    // Dispatch the production deadline callback promptly without changing its value
    // or waiting 110 seconds. The late-success control settles after that callback.
    const timer = mode.includes('deadline')
      ? 'const nativeTimeout=globalThis.setTimeout;globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===110000?10:ms,...args);'
      : '';
    const succeeded = mode.startsWith('success');
    const output = succeeded ? 'stdout' : 'stderr';
    const child = spawn(process.execPath, ['--input-type=module', '-e', `${timer}\n${main}\n${boundary}
process.${output}.write('x'.repeat(4*1024*1024)); process.send('ready');`], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' },
    });
    const stream = child[output];
    if (stream === null) throw new Error('Task-stop fixture requires an output pipe');
    stream.pause();
    const closed = once(child, 'close');
    const exited = once(child, 'exit');
    const watchdog = setTimeout(() => child.kill('SIGKILL'), 3_000);
    let tail = '';
    let stdout = '';
    let stderr = '';
    if (mode === 'success-before-deadline') child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    if (mode === 'deadline-late-success') child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    try {
      await once(child, 'message');
      child.kill('SIGTERM');
      // Keep the parent reader paused while the handler logs and attempts to exit.
      await new Promise((resolve) => setTimeout(resolve, 100));
      stream.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4096); });
      stream.resume();
      const [code, signal] = await exited;
      await closed;
      expect(signal).toBeNull();
      if (mode === 'deadline-late-success') expect(stdout).not.toContain('Agent Computers slept at task stop');
      if (mode === 'success-before-deadline') expect(stderr).not.toContain('Agent Computer sleep at task stop failed');
      if (mode === 'later-failure') expect(tail).toMatch(/failed Error: sleep failed control[\s\S]*failed Error: later sleep failed/);
      expect(code).toBe(succeeded ? 0 : 1);
      expect(tail).toContain(succeeded
        ? 'Agent Computers slept at task stop: browser-proven'
        : 'Agent Computer sleep at task stop failed');
    } finally {
      clearTimeout(watchdog);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
}
