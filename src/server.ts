import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import { decompose, synthesize } from './orchestrator';
import { runWorkers, WorkerController } from './worker-runner';
import { initManifest } from './manifest';
import { WorkerState, ForgeEvent, Subtask } from './types';

export interface ServerOptions {
  port: number;
  orchModel: string;
  workerModel: string;
}

interface Session {
  id: string;
  task: string;
  workDir: string;
  model: string;          // orch model
  workerModel: string;
  parallel: number;
  subtasks: Subtask[];
  states: Map<number, WorkerState>;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  finishedAt?: number;
  controller?: WorkerController;
  error?: string;
}

const sessions = new Map<string, Session>();
const wsClients = new Set<WebSocket>();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min after completion
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function serializeSession(s: Session) {
  return {
    id: s.id,
    task: s.task,
    workDir: s.workDir,
    model: s.model,
    workerModel: s.workerModel,
    parallel: s.parallel,
    subtasks: s.subtasks.map((st) => ({
      id: st.id,
      title: st.title,
      description: st.description,
      deps: st.deps,
      complexity: st.complexity,
    })),
    states: Object.fromEntries(s.states),
    status: s.status,
    createdAt: s.createdAt,
    finishedAt: s.finishedAt,
    error: s.error,
  };
}

function broadcast(msg: any) {
  const data = JSON.stringify(msg);
  for (const ws of wsClients) {
    if (ws.readyState === WebSocket.OPEN) {
      try { ws.send(data); } catch { /* ignore */ }
    }
  }
}

async function startSession(
  task: string,
  workDir: string,
  orchModel: string,
  workerModel: string,
  parallel: number
): Promise<Session> {
  const id = randomUUID();
  const session: Session = {
    id,
    task,
    workDir,
    model: orchModel,
    workerModel,
    parallel,
    subtasks: [],
    states: new Map(),
    status: 'running',
    createdAt: Date.now(),
  };
  sessions.set(id, session);

  // Notify clients a new session was created (empty plan for now)
  broadcast({ type: 'session_created', session: serializeSession(session) });

  // Run in background; capture failures in session.error
  (async () => {
    try {
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

      const subtasks = await decompose(task, orchModel, false);
      session.subtasks = subtasks;

      broadcast({ type: 'session_planned', id: session.id, session: serializeSession(session) });

      await initManifest(workDir, task);

      const ctrl = runWorkers({
        subtasks,
        workDir,
        model: workerModel,
        orchModel,
        parallel,
        verbose: false,
        sessionId: id,
        onUpdate: (states) => {
          session.states = states;
        },
        onEvent: (_sid, event) => {
          // Wrap with an envelope — event already has its own `type` field.
          broadcast({ envelope: 'event', ...event });
        },
      });
      session.controller = ctrl;

      const finalStates = await ctrl.result;
      session.states = finalStates;
      session.status = 'done';
      session.finishedAt = Date.now();

      // Optional synthesis
      try {
        const done = Array.from(finalStates.values())
          .filter((s) => s.status === 'done')
          .map((s) => ({ id: s.taskId, title: s.title, result: s.result || '' }));
        if (done.length > 0) {
          const report = await synthesize(task, done, orchModel);
          (session as any).report = report;
        }
      } catch { /* ignore synthesis errors */ }

      broadcast({
        type: 'session_done',
        id: session.id,
        session: serializeSession(session),
      });
    } catch (err: any) {
      session.status = 'error';
      session.error = String(err?.message || err);
      session.finishedAt = Date.now();
      broadcast({
        type: 'session_error',
        id: session.id,
        error: session.error,
        session: serializeSession(session),
      });
    }
  })();

  return session;
}

function cleanupOldSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (s.status !== 'running' && s.finishedAt && now - s.finishedAt > SESSION_TTL_MS) {
      sessions.delete(id);
      broadcast({ type: 'session_removed', id });
    }
  }
}

export async function startServer(opts: ServerOptions): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  const publicDir = path.resolve(__dirname, '..', 'public');
  if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, sessions: sessions.size });
  });

  app.get('/sessions', (_req: Request, res: Response) => {
    res.json(Array.from(sessions.values()).map(serializeSession));
  });

  app.get('/sessions/:id', (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json(serializeSession(s));
  });

  app.post('/sessions', async (req: Request, res: Response) => {
    const { task, dir, model, workerModel, parallel } = req.body || {};
    if (!task || typeof task !== 'string') {
      return res.status(400).json({ error: 'task is required' });
    }
    const workDir = path.resolve(String(dir || process.cwd()));
    const orchM = String(model || opts.orchModel);
    const workerM = String(workerModel || opts.workerModel);
    const par = Math.max(1, parseInt(String(parallel ?? 3), 10) || 3);

    try {
      const session = await startSession(task, workDir, orchM, workerM, par);
      res.json({ id: session.id, task: session.task });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message || err) });
    }
  });

  app.delete('/sessions/:id', (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (s.controller) {
      // kill all active workers
      for (const [taskId] of s.states) {
        try { s.controller.kill(taskId); } catch { /* ignore */ }
      }
    }
    sessions.delete(req.params.id);
    broadcast({ type: 'session_removed', id: req.params.id });
    res.json({ ok: true });
  });

  app.delete('/sessions/:id/workers/:taskId', (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    if (!s.controller) return res.status(409).json({ error: 'no_controller' });
    const tid = parseInt(req.params.taskId, 10);
    const ok = s.controller.kill(tid);
    res.json({ ok });
  });

  app.get('/sessions/:id/manifest', async (req: Request, res: Response) => {
    const s = sessions.get(req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    const manifestPath = path.join(s.workDir, '.forge-manifest.json');
    try {
      const data = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      res.json(Array.isArray(data) ? data : []);
    } catch {
      res.json([]);
    }
  });

  app.get('/sessions/:id/workers/:taskId/log', async (req: Request, res: Response) => {
    const tid = req.params.taskId;
    const logPath = `/tmp/forge-logs/worker-${tid}.log`;
    try {
      const content = await fs.promises.readFile(logPath, 'utf8');
      const lines = content.split('\n');
      res.json({ lines: lines.slice(-100) }); // last 100 lines
    } catch {
      res.json({ lines: [] });
    }
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    // initial snapshot
    try {
      ws.send(JSON.stringify({
        type: 'snapshot',
        sessions: Array.from(sessions.values()).map(serializeSession),
      }));
    } catch { /* ignore */ }

    ws.on('close', () => wsClients.delete(ws));
    ws.on('error', () => wsClients.delete(ws));

    (ws as any).isAlive = true;
    ws.on('pong', () => { (ws as any).isAlive = true; });
  });

  // heartbeat — drop dead connections
  const heartbeat = setInterval(() => {
    for (const ws of wsClients) {
      const alive = (ws as any).isAlive;
      if (alive === false) {
        try { ws.terminate(); } catch { /* ignore */ }
        wsClients.delete(ws);
        continue;
      }
      (ws as any).isAlive = false;
      try { ws.ping(); } catch { /* ignore */ }
    }
  }, 30_000);

  const cleanupTimer = setInterval(cleanupOldSessions, CLEANUP_INTERVAL_MS);

  server.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(cleanupTimer);
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, () => {
      const url = `http://localhost:${opts.port}`;
      process.stderr.write(chalk.bold(`Forge Control Center\n`));
      process.stderr.write(chalk.gray(`  URL:      ${url}\n`));
      process.stderr.write(chalk.gray(`  WS:       ws://localhost:${opts.port}/ws\n`));
      process.stderr.write(chalk.gray(`  Orch:     ${opts.orchModel}\n`));
      process.stderr.write(chalk.gray(`  Worker:   ${opts.workerModel}\n`));
      resolve();
    });
  });

  // keep process alive
  return new Promise<void>(() => {});
}
