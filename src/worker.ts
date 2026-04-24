import * as fs from 'fs';
import * as path from 'path';
import { chat, ChatMessage, ToolCall, textOf } from './llm';
import { TOOL_DEFINITIONS, runTool, isFinishTool } from './tools';
import { WorkerMessage, RunnerMessage } from './protocol';
import { Subtask } from './types';

const LOG_DIR = '/tmp/forge-logs';
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch {}

function send(msg: WorkerMessage) {
  if (process.send) process.send(msg);
}

// Pending spawn_agent requests: requestId → resolve(result)
const pendingAgentRequests = new Map<string, (result: string) => void>();

process.on('message', (raw: unknown) => {
  const msg = raw as RunnerMessage;
  if (msg?.type === 'agent_result') {
    const resolve = pendingAgentRequests.get(msg.requestId);
    if (resolve) {
      pendingAgentRequests.delete(msg.requestId);
      resolve(msg.result);
    }
  }
});

function spawnSubAgent(taskId: number, task: string, parallel: number): Promise<string> {
  return new Promise((resolve) => {
    const requestId = `${taskId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingAgentRequests.set(requestId, resolve);
    send({ type: 'spawn_agent', taskId, requestId, task, parallel: parallel || 2 });
    // Timeout: 3 minutes
    setTimeout(() => {
      if (pendingAgentRequests.has(requestId)) {
        pendingAgentRequests.delete(requestId);
        resolve('[spawn_agent timeout after 3m]');
      }
    }, 3 * 60 * 1000);
  });
}

function log(taskId: number, line: string) {
  try {
    fs.appendFileSync(
      path.join(LOG_DIR, `worker-${taskId}.log`),
      `[${new Date().toISOString()}] ${line}\n`
    );
  } catch {}
}

const WORKER_SYSTEM = (workDir: string) => `You are an autonomous coding agent executing one subtask.

Work directory: ${workDir}
Available tools: bash, read_file, write_file, list_files, search_code, finish

Instructions:
- Start by listing existing files to understand the current state
- Execute the subtask completely and correctly
- For code files: implement the full, working version (not stubs)
- Use bash for running commands: npm install, node, etc.
- Paths can be relative to the work directory
- When done, call finish(summary) with a concise description of what you created/changed
- On unrecoverable error (2 retries), call finish with the failure summary
- Never ask questions — use best judgment and proceed`;

interface RunArgs {
  subtask: Subtask;
  workDir: string;
  model: string;
  verbose: boolean;
}

function parseArgs(raw: string): any {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

async function runWorker(args: RunArgs): Promise<void> {
  const { subtask, workDir, model } = args;
  const taskId = subtask.id;
  send({ type: 'started', taskId });
  log(taskId, `started: ${subtask.title}`);

  const contextBlock = subtask.context
    ? `\n\nContext from completed dependencies:\n${subtask.context}\n`
    : '';

  const messages: ChatMessage[] = [
    { role: 'system', content: WORKER_SYSTEM(workDir) },
    {
      role: 'user',
      content: `Subtask #${subtask.id}: ${subtask.title}\n\n${subtask.description}${contextBlock}\n\nComplete this task. Call "finish" with a summary when done.`,
    },
  ];

  let totalTokens = 0;
  let steps = 0;
  const MAX_STEPS = 20;

  try {
    while (steps < MAX_STEPS) {
      steps++;
      send({
        type: 'progress',
        taskId,
        message: `step ${steps}: thinking...`,
        progress: Math.min(5 + steps * 8, 90),
      });

      const resp = await chat({
        model,
        max_tokens: 2048,
        messages,
        tools: TOOL_DEFINITIONS,
      });

      totalTokens +=
        (resp.usage?.prompt_tokens || 0) + (resp.usage?.completion_tokens || 0);
      const choice = resp.choices[0];
      if (!choice) throw new Error('no choices in response');

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: textOf(choice.message) || null,
        tool_calls: choice.message.tool_calls,
      };
      messages.push(assistantMsg);

      log(taskId, `step ${steps} finish_reason=${choice.finish_reason} tool_calls=${choice.message.tool_calls?.length || 0}`);

      const toolCalls: ToolCall[] = choice.message.tool_calls || [];
      if (toolCalls.length === 0) {
        const final = textOf(choice.message).trim();
        send({
          type: 'done',
          taskId,
          result: final || '(no summary)',
          tokens: totalTokens,
        });
        log(taskId, `done (no tools)`);
        return;
      }

      let finished = false;
      let finishSummary = '';

      for (const tc of toolCalls) {
        const name = tc.function.name;
        const input = parseArgs(tc.function.arguments);
        send({ type: 'tool_call', taskId, tool: name, args: input });
        log(taskId, `tool_call ${name} ${JSON.stringify(input).slice(0, 200)}`);

        let resultText: string;
        if (isFinishTool(name)) {
          finished = true;
          finishSummary = String(input?.summary ?? '');
          resultText = 'OK';
        } else if (name === 'spawn_agent') {
          send({ type: 'tool_call', taskId, tool: 'spawn_agent', args: input });
          send({ type: 'progress', taskId, message: `spawning sub-agent: ${String(input?.task ?? '').slice(0, 60)}...` });
          resultText = await spawnSubAgent(taskId, String(input?.task ?? ''), Number(input?.parallel) || 2);
          send({ type: 'tool_result', taskId, tool: 'spawn_agent', ok: true });
        } else {
          try {
            resultText = await runTool(workDir, name, input, taskId, subtask.title);
            send({ type: 'tool_result', taskId, tool: name, ok: true });
          } catch (err: any) {
            resultText = `[tool error] ${err.message}`;
            send({ type: 'tool_result', taskId, tool: name, ok: false });
          }
        }
        log(taskId, `tool_result ${name} len=${resultText.length}`);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: resultText,
        });
      }

      if (finished) {
        send({
          type: 'done',
          taskId,
          result: finishSummary || '(finished)',
          tokens: totalTokens,
        });
        log(taskId, `finished via tool`);
        return;
      }
    }

    send({
      type: 'error',
      taskId,
      error: `max steps (${MAX_STEPS}) reached`,
      tokens: totalTokens,
    });
    log(taskId, `ERROR max_steps`);
  } catch (err: any) {
    send({
      type: 'error',
      taskId,
      error: err.message || String(err),
      tokens: totalTokens,
    });
    log(taskId, `ERROR ${err.message}`);
  }
}

function main() {
  const raw = process.argv[2];
  if (!raw) {
    send({ type: 'error', taskId: -1, error: 'worker: missing subtask arg' });
    process.exit(1);
  }
  let parsed: RunArgs;
  try {
    parsed = JSON.parse(raw);
  } catch (err: any) {
    send({
      type: 'error',
      taskId: -1,
      error: `worker: bad JSON arg: ${err.message}`,
    });
    process.exit(1);
    return;
  }
  runWorker(parsed).catch((err) => {
    send({
      type: 'error',
      taskId: parsed.subtask?.id ?? -1,
      error: err.message || String(err),
    });
    process.exit(1);
  });
}

main();
