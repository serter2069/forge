import { Subtask } from './types';

export type WorkerMessage =
  | { type: 'started'; taskId: number }
  | { type: 'progress'; taskId: number; message: string; progress?: number }
  | { type: 'tool_call'; taskId: number; tool: string; args: unknown }
  | { type: 'tool_result'; taskId: number; tool: string; ok: boolean }
  | { type: 'done'; taskId: number; result: string; tokens: number }
  | { type: 'error'; taskId: number; error: string; tokens?: number }
  | { type: 'spawn_agent'; taskId: number; requestId: string; task: string; parallel: number };

export type RunnerMessage =
  | { type: 'agent_result'; requestId: string; result: string };

export interface OrchestratorTaskMessage {
  type: 'task';
  subtask: Subtask;
  workDir: string;
  model: string;
  verbose: boolean;
}
