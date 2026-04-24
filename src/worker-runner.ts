import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import { Subtask, WorkerState } from './types';
import { WorkerMessage, RunnerMessage } from './protocol';
import { decompose } from './orchestrator';

const WORKER_TIMEOUT_MS = 15 * 60 * 1000; // 15min — enough for nested spawn_agent calls

export interface RunnerConfig {
  subtasks: Subtask[];
  workDir: string;
  model: string;
  orchModel: string;
  parallel: number;
  verbose: boolean;
  onUpdate: (states: Map<number, WorkerState>) => void;
}

async function runSubAgent(cfg: RunnerConfig, task: string, parallel: number): Promise<string> {
  try {
    const subtasks = await decompose(task, cfg.orchModel, cfg.verbose);
    const subCfg: RunnerConfig = {
      ...cfg,
      subtasks,
      parallel: Math.min(parallel, cfg.parallel),
      onUpdate: () => {},
    };
    const states = await runWorkers(subCfg);
    const done = Array.from(states.values()).filter((s) => s.status === 'done');
    if (done.length === 0) return '[sub-agent: all tasks failed]';
    // Return raw results — no synthesis LLM call (would add latency that triggers timeout)
    return done.map((s) => `[${s.title}]: ${s.result}`).join('\n');
  } catch (err: any) {
    return `[sub-agent error: ${err.message}]`;
  }
}

export async function runWorkers(cfg: RunnerConfig): Promise<Map<number, WorkerState>> {
  const states = new Map<number, WorkerState>();
  for (const st of cfg.subtasks) {
    states.set(st.id, {
      taskId: st.id,
      title: st.title,
      status: 'waiting',
      progress: 0,
      message: '',
      tokens: 0,
      model: cfg.model,
    });
  }

  const active = new Map<number, ChildProcess>();
  const timeouts = new Map<number, NodeJS.Timeout>();

  const workerScript = path.resolve(__dirname, 'worker.js');

  const depsSatisfied = (st: Subtask): boolean =>
    st.deps.every((d) => states.get(d)?.status === 'done');

  const anyFailed = (st: Subtask): boolean =>
    st.deps.some((d) => states.get(d)?.status === 'error');

  const allFinished = (): boolean =>
    Array.from(states.values()).every(
      (s) => s.status === 'done' || s.status === 'error'
    );

  return new Promise((resolve) => {
    const spawnWorker = (st: Subtask) => {
      const state = states.get(st.id)!;
      state.status = 'running';
      state.startedAt = Date.now();
      state.message = 'starting...';
      cfg.onUpdate(states);

      const arg = JSON.stringify({
        subtask: st,
        workDir: cfg.workDir,
        model: cfg.model,
        verbose: cfg.verbose,
      });

      const child = fork(workerScript, [arg], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
      });

      active.set(st.id, child);

      const timeout = setTimeout(() => {
        state.status = 'error';
        state.error = `timeout after ${WORKER_TIMEOUT_MS}ms`;
        state.finishedAt = Date.now();
        try {
          child.kill('SIGKILL');
        } catch {}
        active.delete(st.id);
        cfg.onUpdate(states);
        tryScheduleMore();
      }, WORKER_TIMEOUT_MS);
      timeouts.set(st.id, timeout);

      child.on('message', (raw: unknown) => {
        const msg = raw as WorkerMessage;
        if (!msg || typeof msg !== 'object') return;

        // Handle spawn_agent request from worker
        if (msg.type === 'spawn_agent') {
          state.message = `sub-agent: ${msg.task.slice(0, 50)}...`;
          cfg.onUpdate(states);
          runSubAgent(cfg, msg.task, msg.parallel).then((result) => {
            const reply: RunnerMessage = { type: 'agent_result', requestId: msg.requestId, result };
            try { child.send(reply); } catch { /* worker already exited */ }
          });
          return;
        }

        switch (msg.type) {
          case 'started':
            state.message = 'started';
            break;
          case 'progress':
            state.message = msg.message;
            if (typeof msg.progress === 'number') state.progress = msg.progress;
            break;
          case 'tool_call':
            state.message = `tool: ${msg.tool}`;
            break;
          case 'tool_result':
            break;
          case 'done':
            state.status = 'done';
            state.progress = 100;
            state.result = msg.result;
            state.tokens = msg.tokens;
            state.finishedAt = Date.now();
            state.message = 'done';
            for (const dep of cfg.subtasks) {
              if (dep.deps.includes(st.id)) {
                const prev = dep.context ? dep.context + '\n\n' : '';
                dep.context = `${prev}[Result from "${st.title}"]: ${msg.result}`;
              }
            }
            break;
          case 'error':
            state.status = 'error';
            state.error = msg.error;
            state.tokens = msg.tokens || state.tokens;
            state.finishedAt = Date.now();
            state.message = `error: ${msg.error?.slice(0, 80)}`;
            break;
        }
        cfg.onUpdate(states);
      });

      child.stderr?.on('data', (d) => {
        if (cfg.verbose) process.stderr.write(`[worker ${st.id}] ${d}`);
      });

      child.on('exit', (code) => {
        const t = timeouts.get(st.id);
        if (t) {
          clearTimeout(t);
          timeouts.delete(st.id);
        }
        active.delete(st.id);
        if (state.status === 'running') {
          state.status = 'error';
          state.error = `worker exited with code ${code}`;
          state.finishedAt = Date.now();
          cfg.onUpdate(states);
        }
        tryScheduleMore();
      });
    };

    const tryScheduleMore = () => {
      if (allFinished()) {
        resolve(states);
        return;
      }
      for (const st of cfg.subtasks) {
        const state = states.get(st.id)!;
        if (state.status !== 'waiting') continue;
        if (active.size >= cfg.parallel) break;
        if (anyFailed(st)) {
          state.status = 'error';
          state.error = 'dependency failed';
          state.finishedAt = Date.now();
          cfg.onUpdate(states);
          continue;
        }
        if (!depsSatisfied(st)) continue;
        spawnWorker(st);
      }
      if (allFinished()) resolve(states);
    };

    const onSigint = () => {
      for (const child of active.values()) {
        try {
          child.kill('SIGTERM');
        } catch {}
      }
      process.exit(130);
    };
    process.once('SIGINT', onSigint);

    tryScheduleMore();
  });
}
