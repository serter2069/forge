import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';
import { decompose, synthesize } from './orchestrator';
import { runWorkers } from './worker-runner';
import { createDashboard } from './dashboard';
import { WorkerState } from './types';
import { initManifest, readManifest } from './manifest';

function areAllFinal(states: Map<number, WorkerState>): boolean {
  return Array.from(states.values()).every(
    (s) => s.status === 'done' || s.status === 'error'
  );
}

async function runTurn(
  task: string,
  workDir: string,
  model: string,
  workerModel: string,
  parallel: number,
  verbose: boolean
): Promise<void> {
  console.log('');
  console.log(chalk.cyan('→ Decomposing...'));
  const subtasks = await decompose(task, model, verbose);
  console.log(chalk.cyan(`→ Plan (${subtasks.length} subtasks):`));
  for (const s of subtasks) {
    const deps = s.deps.length ? chalk.gray(` [deps: ${s.deps.join(',')}]`) : '';
    console.log(`  ${chalk.bold(`[${s.id}]`)} ${s.title} ${chalk.gray(`(${s.complexity})`)}${deps}`);
  }
  console.log('');

  const startTime = Date.now();
  const tty = Boolean(process.stdout.isTTY);
  const dashboard = createDashboard(task, tty, startTime);

  let lastRender = 0;
  const onUpdate = (states: Map<number, WorkerState>) => {
    const now = Date.now();
    if (now - lastRender >= 500 || areAllFinal(states)) {
      lastRender = now;
      dashboard.update(states);
    }
  };

  await initManifest(workDir, task);

  const ctrl = runWorkers({ subtasks, workDir, model: workerModel, orchModel: model, parallel, verbose, onUpdate });
  const states = await ctrl.result;
  dashboard.update(states);

  const doneResults = Array.from(states.values())
    .filter((s) => s.status === 'done')
    .map((s) => ({ id: s.taskId, title: s.title, result: s.result || '' }));
  const errors = Array.from(states.values()).filter((s) => s.status === 'error');

  console.log('');
  if (doneResults.length > 0) {
    const finalReport = await synthesize(task, doneResults, model);
    dashboard.finalize(finalReport);
  } else {
    dashboard.finalize(chalk.red('No subtasks completed.'));
  }

  if (errors.length > 0) {
    console.log(chalk.red(`\n✗ ${errors.length} error(s):`));
    for (const e of errors) {
      console.log(chalk.red(`  [${e.taskId}] ${e.title}: ${e.error}`));
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const tokens = Array.from(states.values()).reduce((sum, s) => sum + (s.tokens || 0), 0);
  console.log(chalk.gray(`\n  ${doneResults.length}/${subtasks.length} done · ${elapsed}s · ${tokens.toLocaleString()} tokens`));
}

export async function startRepl(opts: {
  workDir?: string;
  model: string;
  workerModel: string;
  parallel: number;
  verbose: boolean;
}): Promise<void> {
  console.log(chalk.bold('\nForge') + chalk.gray(' — interactive mode'));
  console.log(chalk.gray('Commands: /exit  /dir <path>  /files  /clear (reset board)\n'));

  // Resolve working directory
  let workDir: string;
  if (opts.workDir) {
    workDir = path.resolve(opts.workDir);
  } else {
    const sessionId = Date.now().toString(36);
    workDir = path.join(os.tmpdir(), `forge-session-${sessionId}`);
    console.log(chalk.gray(`Working dir: ${workDir} (new session)`));
  }

  if (!fs.existsSync(workDir)) {
    fs.mkdirSync(workDir, { recursive: true });
  }

  console.log(chalk.cyan(`Dir: ${workDir}`));
  console.log(chalk.gray(`Orchestrator: ${opts.model} | Worker: ${opts.workerModel} | Parallel: ${opts.parallel}`));

  // Show existing files if any
  try {
    const entries = fs.readdirSync(workDir).filter((f) => !f.startsWith('.'));
    if (entries.length > 0) {
      console.log(chalk.gray(`\nExisting files: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? ` +${entries.length - 8} more` : ''}`));
    }
  } catch {}

  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.bold.green('You: '),
    terminal: true,
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Special commands
    if (input === '/exit' || input === 'exit' || input === 'quit') {
      console.log(chalk.gray('\nBye.'));
      rl.close();
      process.exit(0);
    }

    if (input.startsWith('/dir ')) {
      const newDir = path.resolve(input.slice(5).trim());
      if (!fs.existsSync(newDir)) {
        try {
          fs.mkdirSync(newDir, { recursive: true });
        } catch {
          console.log(chalk.red(`Cannot create: ${newDir}`));
          rl.prompt();
          return;
        }
      }
      workDir = newDir;
      console.log(chalk.cyan(`Dir → ${workDir}`));
      rl.prompt();
      return;
    }

    if (input === '/files') {
      try {
        const entries = fs.readdirSync(workDir);
        if (entries.length === 0) {
          console.log(chalk.gray('(no files yet)'));
        } else {
          for (const e of entries.filter((f) => !f.startsWith('.'))) {
            console.log(chalk.gray(`  ${e}`));
          }
        }
      } catch (err: any) {
        console.log(chalk.red(err.message));
      }
      rl.prompt();
      return;
    }

    if (input === '/clear') {
      const boardFile = path.join(workDir, '.forge-board.json');
      try { fs.unlinkSync(boardFile); } catch {}
      console.log(chalk.gray('Board cleared.'));
      rl.prompt();
      return;
    }

    // Pause readline while running so dashboard renders cleanly
    rl.pause();

    try {
      await runTurn(input, workDir, opts.model, opts.workerModel, opts.parallel, opts.verbose);
    } catch (err: any) {
      console.error(chalk.red(`\nError: ${err.message}`));
    }

    console.log('');
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}
