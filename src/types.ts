export type Complexity = 'low' | 'medium' | 'high';

export interface Subtask {
  id: number;
  title: string;
  description: string;
  deps: number[];
  complexity: Complexity;
  context?: string; // results from completed dependency tasks
}

export type WorkerStatus = 'waiting' | 'running' | 'done' | 'error';

export interface WorkerState {
  taskId: number;
  title: string;
  status: WorkerStatus;
  progress: number; // 0..100
  message: string;
  tokens: number;
  startedAt?: number;
  finishedAt?: number;
  result?: string;
  error?: string;
  model?: string;
}

export interface ForgeOptions {
  parallel: number;
  model: string;
  workerModel: string;
  dir: string;
  dryRun: boolean;
  verbose: boolean;
}

export interface ForgeEvent {
  type: 'worker_update' | 'session_done' | 'spawn_agent_start';
  sessionId: string;
  taskId?: number;
  state?: WorkerState;
  states?: Record<number, WorkerState>;
  message?: string;
}
