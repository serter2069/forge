import chalk from 'chalk';
import { WorkerState } from './types';

const BAR_WIDTH = 10;

function bar(progress: number): string {
  const filled = Math.round((progress / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function statusBadge(s: WorkerState): string {
  switch (s.status) {
    case 'waiting':
      return chalk.gray('waiting');
    case 'running':
      return chalk.cyan('running');
    case 'done':
      return chalk.green('done ✓ ');
    case 'error':
      return chalk.red('error ✗');
  }
}

function pad(s: string, n: number): string {
  const visible = s.replace(/\[[0-9;]*m/g, '');
  if (visible.length >= n) return s;
  return s + ' '.repeat(n - visible.length);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + '…';
}

export interface DashboardHandle {
  update: (states: Map<number, WorkerState>) => void;
  stop: () => void;
  finalize: (final: string) => void;
}

export function createDashboard(
  task: string,
  tty: boolean,
  startTime: number
): DashboardHandle {
  let lastLines = 0;
  let stopped = false;

  const render = (states: Map<number, WorkerState>): string[] => {
    const list = Array.from(states.values()).sort((a, b) => a.taskId - b.taskId);
    const running = list.filter((s) => s.status === 'running').length;
    const done = list.filter((s) => s.status === 'done').length;
    const error = list.filter((s) => s.status === 'error').length;
    const waiting = list.filter((s) => s.status === 'waiting').length;
    const tokens = list.reduce((a, s) => a + s.tokens, 0);
    const cost = (tokens * 0.000003).toFixed(4); // rough estimate
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    const lines: string[] = [];
    lines.push(chalk.bold(`Forge — "${truncate(task, 60)}"`));
    lines.push(chalk.gray('─'.repeat(64)));

    for (const s of list) {
      const id = chalk.bold(`[${s.taskId}]`);
      const title = pad(truncate(s.title, 22), 22);
      const b = bar(s.progress);
      const pct = pad(`${s.progress}%`, 4);
      const badge = statusBadge(s);
      let extra = '';
      if (s.status === 'done' && s.startedAt && s.finishedAt) {
        extra = chalk.gray(`+${((s.finishedAt - s.startedAt) / 1000).toFixed(1)}s`);
      } else if (s.status === 'error') {
        extra = chalk.red(truncate(s.error || '', 30));
      } else if (s.status === 'running') {
        extra = chalk.gray(truncate(s.message, 30));
      } else if (s.status === 'waiting') {
        extra = chalk.gray('(waiting on deps)');
      }
      lines.push(`${id} ${title} ${b} ${pct}  ${badge}  ${extra}`);
    }

    lines.push('');
    lines.push(
      chalk.gray(
        `Workers: ${chalk.cyan(running)} active / ${chalk.green(done)} done / ${chalk.red(error)} error / ${chalk.gray(waiting)} waiting`
      )
    );
    lines.push(
      chalk.gray(
        `Tokens: ${tokens.toLocaleString()} | Cost: ~$${cost} | Time: ${elapsed}s`
      )
    );
    return lines;
  };

  const write = (states: Map<number, WorkerState>) => {
    if (stopped) return;
    const lines = render(states);
    if (tty) {
      // Move cursor up and clear previous output
      if (lastLines > 0) {
        process.stdout.write(`\x1b[${lastLines}A`);
        for (let i = 0; i < lastLines; i++) {
          process.stdout.write('\x1b[2K\n');
        }
        process.stdout.write(`\x1b[${lastLines}A`);
      }
      process.stdout.write(lines.join('\n') + '\n');
      lastLines = lines.length;
    } else {
      // Non-TTY: print status snapshot occasionally
      process.stdout.write(lines.join('\n') + '\n---\n');
    }
  };

  return {
    update: write,
    stop: () => {
      stopped = true;
    },
    finalize: (final: string) => {
      stopped = true;
      process.stdout.write('\n' + chalk.bold('Final result:') + '\n');
      process.stdout.write(final + '\n');
    },
  };
}
