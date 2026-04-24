import * as readline from 'readline';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import chalk from 'chalk';
import { chat, textOf, isMockMode } from './llm';
import { decompose, synthesize } from './orchestrator';
import { runWorkers } from './worker-runner';
import { WorkerState } from './types';
import { initManifest } from './manifest';

function areAllFinal(states: Map<number, WorkerState>): boolean {
  return Array.from(states.values()).every(
    (s) => s.status === 'done' || s.status === 'error'
  );
}

// Decide if message needs workers or can be answered directly
async function classify(message: string, model: string): Promise<'task' | 'chat'> {
  if (isMockMode()) return 'task';
  try {
    const resp = await chat({
      model,
      max_tokens: 10,
      temperature: 0,
      messages: [{
        role: 'user',
        content: `Does this message require creating or modifying code/files? Reply only TASK or CHAT.\nMessage: "${message}"`,
      }],
    });
    const answer = textOf(resp.choices[0]?.message).trim().toUpperCase();
    return answer.startsWith('TASK') ? 'task' : 'chat';
  } catch {
    return 'task'; // fallback: treat as task
  }
}

// Direct LLM answer for non-coding messages
async function directAnswer(message: string, model: string): Promise<void> {
  try {
    const resp = await chat({
      model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: message }],
    });
    const answer = textOf(resp.choices[0]?.message).trim();
    console.log(chalk.white(answer));
  } catch (err: any) {
    console.log(chalk.red(`Error: ${err.message}`));
  }
}

// Simple non-animated progress for REPL — one line per event
function makeReplProgress(verbose: boolean) {
  const seen = new Set<string>();
  return (states: Map<number, WorkerState>) => {
    if (!verbose) return;
    for (const s of states.values()) {
      const key = `${s.taskId}:${s.status}:${s.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (s.status === 'running' && s.message !== 'starting...') {
        process.stdout.write(chalk.gray(`  [${s.taskId}] ${s.message}\n`));
      }
    }
  };
}

async function runCodingTask(
  task: string,
  workDir: string,
  model: string,
  workerModel: string,
  parallel: number,
  verbose: boolean
): Promise<void> {
  const startTime = Date.now();

  const planFrames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let pfi = 0;
  const planSpinner = setInterval(() => {
    process.stdout.write(`\r${chalk.gray(planFrames[pfi++ % planFrames.length])} ${chalk.cyan('planning...')}`);
  }, 80);
  const subtasks = await decompose(task, model, verbose);
  clearInterval(planSpinner);
  process.stdout.write(`\r\x1b[2K${chalk.cyan(`→ ${subtasks.length} task${subtasks.length > 1 ? 's' : ''}: `)}${subtasks.map((s) => chalk.bold(s.title)).join(', ')}\n`);

  await initManifest(workDir, task);

  const onUpdate = makeReplProgress(verbose);

  // Live status: one spinner line, overwrite in place
  let lastStatus = '';
  const updateStatus = (states: Map<number, WorkerState>) => {
    onUpdate(states);
    const running = Array.from(states.values()).filter((s) => s.status === 'running');
    const done = Array.from(states.values()).filter((s) => s.status === 'done').length;
    const total = states.size;
    const names = running.map((s) => s.title).join(', ');
    const line = `  ${chalk.cyan(`${done}/${total}`)} ${chalk.gray(names || 'waiting...')}`;
    if (line !== lastStatus) {
      process.stdout.write(`\r\x1b[2K${line}`);
      lastStatus = line;
    }
  };

  const ctrl = runWorkers({
    subtasks,
    workDir,
    model: workerModel,
    orchModel: model,
    parallel,
    verbose: false,
    onUpdate: updateStatus,
  });
  const states = await ctrl.result;

  // Clear status line
  process.stdout.write(`\r\x1b[2K`);

  const doneResults = Array.from(states.values())
    .filter((s) => s.status === 'done')
    .map((s) => ({ id: s.taskId, title: s.title, result: s.result || '' }));
  const errors = Array.from(states.values()).filter((s) => s.status === 'error');

  // Print per-task results
  for (const s of states.values()) {
    if (s.status === 'done') {
      const duration = s.startedAt && s.finishedAt
        ? chalk.gray(` +${((s.finishedAt - s.startedAt) / 1000).toFixed(1)}s`)
        : '';
      console.log(`  ${chalk.green('✓')} ${s.title}${duration}`);
    } else if (s.status === 'error' && s.error !== 'dependency failed') {
      console.log(`  ${chalk.red('✗')} ${s.title}: ${chalk.red(s.error || '')}`);
    }
  }

  if (doneResults.length > 0) {
    const report = await synthesize(task, doneResults, model);
    console.log('\n' + chalk.white(report));
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const tokens = Array.from(states.values()).reduce((sum, s) => sum + (s.tokens || 0), 0);
  const cost = (tokens * 0.000003).toFixed(4);
  console.log(chalk.gray(`\n  ${doneResults.length}/${subtasks.length} done · ${elapsed}s · ${tokens.toLocaleString()} tokens · ~$${cost}`));
}

export async function startRepl(opts: {
  workDir?: string;
  model: string;
  workerModel: string;
  parallel: number;
  verbose: boolean;
}): Promise<void> {
  console.log(chalk.bold('\nForge') + chalk.gray(' v0.1 · interactive'));
  console.log(chalk.gray('/exit  /dir <path>  /files  /clear\n'));

  let workDir: string;
  if (opts.workDir) {
    workDir = path.resolve(opts.workDir);
  } else {
    const sessionId = Date.now().toString(36);
    workDir = path.join(os.tmpdir(), `forge-session-${sessionId}`);
  }

  if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });

  console.log(chalk.gray(`dir: ${workDir}`));
  try {
    const entries = fs.readdirSync(workDir).filter((f) => !f.startsWith('.'));
    if (entries.length > 0) {
      console.log(chalk.gray(`files: ${entries.slice(0, 6).join(', ')}${entries.length > 6 ? ` +${entries.length - 6}` : ''}`));
    }
  } catch {}
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  rl.prompt();

  let busy = false;

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (busy) return;

    // Slash commands
    if (input === '/exit' || input === 'exit' || input === 'quit') {
      console.log(chalk.gray('bye'));
      process.exit(0);
    }
    if (input.startsWith('/dir ')) {
      workDir = path.resolve(input.slice(5).trim());
      if (!fs.existsSync(workDir)) fs.mkdirSync(workDir, { recursive: true });
      console.log(chalk.gray(`dir → ${workDir}`));
      rl.prompt();
      return;
    }
    if (input === '/files') {
      const entries = fs.readdirSync(workDir).filter((f) => !f.startsWith('.'));
      if (entries.length === 0) console.log(chalk.gray('(empty)'));
      else entries.forEach((e) => console.log(chalk.gray(`  ${e}`)));
      rl.prompt();
      return;
    }
    if (input === '/clear') {
      try { fs.unlinkSync(path.join(workDir, '.forge-board.json')); } catch {}
      console.log(chalk.gray('board cleared'));
      rl.prompt();
      return;
    }

    busy = true;
    rl.pause();

    try {
      // Spinner while classifying
      const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
      let fi = 0;
      const spinner = setInterval(() => {
        process.stdout.write(`\r${chalk.gray(frames[fi++ % frames.length])}`);
      }, 80);

      const kind = await classify(input, opts.model);
      clearInterval(spinner);
      process.stdout.write('\r\x1b[2K');

      if (kind === 'chat') {
        await directAnswer(input, opts.model);
      } else {
        await runCodingTask(input, workDir, opts.model, opts.workerModel, opts.parallel, opts.verbose);
      }
    } catch (err: any) {
      console.error(chalk.red(`\nerror: ${err.message}`));
    }

    console.log('');
    busy = false;
    rl.resume();
    rl.prompt();
  });

  rl.on('close', () => process.exit(0));
}
