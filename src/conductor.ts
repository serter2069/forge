// Chat Conductor — persistent orchestrator LLM that manages parallel workers via tool calls.
//
// The conductor holds a chat with the user. Each turn, the LLM can call tools to:
//   - spawn_worker: fire off a new coding agent for a subtask
//   - list_workers: check statuses
//   - kill_worker: stop a running one
//   - read_worker_result: read output of a completed one
//
// Workers are spawned asynchronously (fire-and-forget) — the tool call returns
// as soon as the worker starts. The conductor can then check back later via
// list_workers / read_worker_result.

import { chat, ChatMessage, ToolDef, textOf } from './llm';
import { runWorkers, WorkerController } from './worker-runner';
import { WorkerState, ForgeEvent, Subtask } from './types';

export interface ConductorMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ConductorSession {
  id: string;
  workDir: string;
  model: string;
  workerModel: string;
  messages: ConductorMessage[];
  workers: Map<number, WorkerState>;
  workerControllers: Map<number, WorkerController>;
  nextTaskId: number;
  status: 'active' | 'done';
  createdAt: number;
}

export const CONDUCTOR_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'spawn_worker',
      description: 'Spawn a new coding agent to work on a specific task in parallel',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short title (5-8 words)' },
          task: { type: 'string', description: 'Full task description for the worker' },
        },
        required: ['title', 'task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_workers',
      description: 'Get the current status of all spawned workers',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_worker',
      description: 'Kill a running worker by task ID',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_worker_result',
      description: 'Read the result/output of a completed worker',
      parameters: {
        type: 'object',
        properties: {
          taskId: { type: 'number' },
        },
        required: ['taskId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_workers',
      description: 'Wait until specified workers finish, then return their results. Use this after spawning workers.',
      parameters: {
        type: 'object',
        properties: {
          taskIds: {
            type: 'array',
            items: { type: 'number' },
            description: 'Task IDs to wait for. Omit to wait for all active workers.',
          },
          timeout_seconds: {
            type: 'number',
            description: 'Max seconds to wait (default 120)',
          },
        },
      },
    },
  },
];

function systemPrompt(workDir: string): string {
  return `You are a coding orchestrator managing a team of parallel coding agents. You work in directory: ${workDir}

Your capabilities:
- spawn_worker: create a new coding agent for a specific subtask
- list_workers: check status of all your agents
- kill_worker: stop a running agent
- read_worker_result: get output from a finished agent

Guidelines:
- Break complex tasks into 2-4 independent parallel subtasks when possible
- Spawn all workers first, then call wait_workers to wait for them all
- After wait_workers returns, summarize what was accomplished and reply to the user
- Be concise. Tell the user what you started before waiting.
- Never call list_workers in a loop — use wait_workers instead.`;
}

function serializeWorker(s: WorkerState) {
  return {
    taskId: s.taskId,
    title: s.title,
    status: s.status,
    progress: s.progress,
    message: s.message,
    tokens: s.tokens,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    hasResult: !!s.result,
    error: s.error,
  };
}

/**
 * Spawn a single worker (fire-and-forget). Returns taskId immediately.
 * The worker runs in background; events flow through onEvent.
 */
function spawnConductorWorker(
  session: ConductorSession,
  title: string,
  task: string,
  onEvent: (event: any) => void
): number {
  const taskId = session.nextTaskId++;
  const subtask: Subtask = {
    id: taskId,
    title,
    description: task,
    deps: [],
    complexity: 'medium',
  };

  // Seed initial state so list_workers sees it right away
  session.workers.set(taskId, {
    taskId,
    title,
    status: 'waiting',
    progress: 0,
    message: '',
    tokens: 0,
    model: session.workerModel,
  });

  const ctrl = runWorkers({
    subtasks: [subtask],
    workDir: session.workDir,
    model: session.workerModel,
    orchModel: session.model,
    parallel: 1,
    verbose: false,
    sessionId: session.id,
    onUpdate: (states) => {
      const s = states.get(taskId);
      if (s) session.workers.set(taskId, s);
    },
    onEvent: (_sid, event: ForgeEvent) => {
      // Update our copy and forward to UI
      if (event.state) session.workers.set(event.state.taskId, event.state);
      onEvent({
        type: event.type === 'session_done' ? 'conductor_worker_update' : 'conductor_worker_update',
        sessionId: session.id,
        taskId: event.taskId,
        state: event.state,
        message: event.message,
      });
    },
  });

  session.workerControllers.set(taskId, ctrl);

  // Don't await — fire and forget. The controller.result promise resolves
  // in the background and session.workers is updated via onUpdate/onEvent.
  ctrl.result.catch(() => { /* ignore — individual errors surfaced via events */ });

  onEvent({
    type: 'conductor_worker_spawned',
    sessionId: session.id,
    state: session.workers.get(taskId),
  });

  return taskId;
}

async function handleToolCall(
  session: ConductorSession,
  name: string,
  argsJson: string,
  onEvent: (event: any) => void
): Promise<string> {
  let args: any = {};
  try { args = JSON.parse(argsJson || '{}'); } catch { /* ignore */ }

  try {
    switch (name) {
      case 'spawn_worker': {
        const title = String(args.title || 'Task');
        const task = String(args.task || '');
        if (!task) return JSON.stringify({ error: 'task is required' });
        const taskId = spawnConductorWorker(session, title, task, onEvent);
        return JSON.stringify({ taskId, status: 'started', title });
      }
      case 'list_workers': {
        const arr = Array.from(session.workers.values()).map(serializeWorker);
        return JSON.stringify({ workers: arr });
      }
      case 'kill_worker': {
        const tid = Number(args.taskId);
        const ctrl = session.workerControllers.get(tid);
        const ok = ctrl ? ctrl.kill(tid) : false;
        return JSON.stringify({ ok, taskId: tid });
      }
      case 'read_worker_result': {
        const tid = Number(args.taskId);
        const w = session.workers.get(tid);
        if (!w) return JSON.stringify({ error: 'worker not found', taskId: tid });
        if (w.status === 'done') return JSON.stringify({ taskId: tid, status: 'done', result: w.result || '' });
        if (w.status === 'error') return JSON.stringify({ taskId: tid, status: 'error', error: w.error || 'unknown' });
        return JSON.stringify({ taskId: tid, status: w.status, message: 'not done yet' });
      }
      case 'wait_workers': {
        const ids: number[] = Array.isArray(args.taskIds) && args.taskIds.length > 0
          ? args.taskIds.map(Number)
          : Array.from(session.workerControllers.keys());
        const timeoutMs = Number(args.timeout_seconds || 180) * 1000;
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          const allDone = ids.every((tid) => {
            const s = session.workers.get(tid)?.status;
            return s === 'done' || s === 'error';
          });
          if (allDone) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
        const results = ids.map((tid) => {
          const w = session.workers.get(tid);
          return { taskId: tid, title: w?.title || '', status: w?.status || 'unknown', result: w?.result || null, error: w?.error || null };
        });
        return JSON.stringify({ workers: results });
      }
      default:
        return JSON.stringify({ error: `unknown tool: ${name}` });
    }
  } catch (err: any) {
    return JSON.stringify({ error: String(err?.message || err) });
  }
}

const MAX_ROUNDS = 16;

/**
 * Run one conversational turn: user message -> LLM loop (with tools) -> assistant text.
 * Broadcasts conductor_message events for both the user message (on entry) and the
 * final assistant reply.
 */
export async function runConductorTurn(
  session: ConductorSession,
  userMessage: string,
  onEvent: (event: any) => void
): Promise<string> {
  const now = Date.now();
  session.messages.push({ role: 'user', content: userMessage, timestamp: now });
  onEvent({
    type: 'conductor_message',
    sessionId: session.id,
    role: 'user',
    content: userMessage,
    timestamp: now,
  });

  // Build LLM messages from history
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(session.workDir) },
    ...session.messages.map((m) => ({ role: m.role, content: m.content } as ChatMessage)),
  ];

  let finalText = '';

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await chat({
      model: session.model,
      messages: llmMessages,
      tools: CONDUCTOR_TOOLS,
      tool_choice: 'auto',
      max_tokens: 2048,
      temperature: 0,
    });

    const choice = resp.choices?.[0];
    if (!choice) { finalText = '(no response)'; break; }
    const msg = choice.message;

    const toolCalls = msg.tool_calls || [];
    const contentText = textOf(msg);

    // Append assistant message (with tool_calls if any) to context
    llmMessages.push({
      role: 'assistant',
      content: contentText || '',
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });

    if (toolCalls.length === 0) {
      finalText = contentText || '(empty)';
      break;
    }

    // Execute each tool call and append tool results
    for (const tc of toolCalls) {
      const result = await handleToolCall(
        session,
        tc.function.name,
        tc.function.arguments,
        onEvent
      );
      llmMessages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }

    // Loop: LLM will see tool results and either call more tools or reply.
    if (choice.finish_reason === 'stop' && !toolCalls.length) {
      finalText = contentText || '(empty)';
      break;
    }
  }

  if (!finalText) finalText = '(max tool rounds reached without final reply)';

  const tsReply = Date.now();
  session.messages.push({ role: 'assistant', content: finalText, timestamp: tsReply });
  onEvent({
    type: 'conductor_message',
    sessionId: session.id,
    role: 'assistant',
    content: finalText,
    timestamp: tsReply,
  });

  return finalText;
}

export function serializeConductorSession(s: ConductorSession) {
  return {
    id: s.id,
    type: 'conductor',
    workDir: s.workDir,
    model: s.model,
    workerModel: s.workerModel,
    messages: s.messages,
    workers: Object.fromEntries(s.workers),
    status: s.status,
    createdAt: s.createdAt,
  };
}

export function killAllWorkers(s: ConductorSession) {
  for (const [tid, ctrl] of s.workerControllers) {
    try { ctrl.kill(tid); } catch { /* ignore */ }
  }
}
