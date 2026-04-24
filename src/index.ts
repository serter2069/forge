import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import { decompose, synthesize } from './orchestrator';
import { runWorkers } from './worker-runner';
import { createDashboard } from './dashboard';
import { WorkerState } from './types';
import { initManifest } from './manifest';

// Defaults target OmniRouter. Kimi K2 is cheap, fast, and supports tool calls.
// "smart" route is Claude Opus via OAuth but distorts system prompts, so avoid it for planning.
const DEFAULT_ORCH_MODEL =
  process.env.FORGE_ORCH_MODEL || 'cliproxyapi/claude-sonnet-4-6';
const DEFAULT_WORKER_MODEL =
  process.env.FORGE_WORKER_MODEL || 'cliproxyapi/claude-haiku-4-5-20251001';

async function main() {
  const program = new Command();
  program
    .name('forge')
    .description('Multi-agent CLI coding agent with parallel orchestration')
    .argument('[task...]', 'task description')
    .option('--parallel <n>', 'max parallel workers', '3')
    .option('--model <m>', 'orchestrator model', DEFAULT_ORCH_MODEL)
    .option('--worker-model <m>', 'worker model', DEFAULT_WORKER_MODEL)
    .option('--dir <path>', 'working directory', process.cwd())
    .option('--dry-run', 'show plan without executing', false)
    .option('--verbose', 'verbose output', false)
    .parse(process.argv);

  const opts = program.opts();
  const args = program.args;

  if (args.length === 0) {
    program.help();
    return;
  }

  const task = args.join(' ');
  const workDir = path.resolve(String(opts.dir));
  const parallel = Math.max(1, parseInt(String(opts.parallel), 10) || 4);
  const model = String(opts.model);
  const workerModel = String(opts.workerModel);
  const dryRun = Boolean(opts.dryRun);
  const verbose = Boolean(opts.verbose);

  if (!fs.existsSync(workDir)) {
    try {
      fs.mkdirSync(workDir, { recursive: true });
    } catch (err: any) {
      console.error(chalk.red(`Cannot create work dir: ${workDir} — ${err.message}`));
      process.exit(1);
    }
  }

  console.log(chalk.bold(`Forge v0.1.0`));
  console.log(chalk.gray(`Task: ${task}`));
  console.log(chalk.gray(`Dir:  ${workDir}`));
  console.log(chalk.gray(`Orchestrator: ${model} | Worker: ${workerModel} | Parallel: ${parallel}`));
  console.log('');

  console.log(chalk.cyan('→ Decomposing task...'));
  const subtasks = await decompose(task, model, verbose);
  console.log(chalk.cyan(`→ Plan (${subtasks.length} subtasks):`));
  for (const s of subtasks) {
    const deps = s.deps.length ? ` [deps: ${s.deps.join(',')}]` : '';
    console.log(`  ${chalk.bold(`[${s.id}]`)} ${s.title} ${chalk.gray(`(${s.complexity})${deps}`)}`);
    if (verbose) console.log(chalk.gray(`      ${s.description}`));
  }
  console.log('');

  if (dryRun) {
    console.log(chalk.yellow('Dry run — exiting.'));
    return;
  }

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

  let states = await runWorkers({
    subtasks,
    workDir,
    model: workerModel,
    orchModel: model,
    parallel,
    verbose,
    onUpdate,
  });

  // Re-plan: if some tasks failed but some succeeded, retry the failures
  const failedFirst = Array.from(states.values()).filter((s) => s.status === 'error' && s.error !== 'dependency failed');
  const doneFirst = Array.from(states.values()).filter((s) => s.status === 'done');
  if (failedFirst.length > 0 && doneFirst.length > 0) {
    console.log(chalk.yellow(`\n→ Re-planning: ${failedFirst.length} failed task(s)...`));
    const doneCtx = doneFirst.map((s) => `"${s.title}": ${s.result}`).join('; ');
    const failCtx = failedFirst.map((s) => `"${s.title}": ${s.error}`).join('; ');
    const replanTask = `${task}\n\nAlready done: ${doneCtx}\nRe-do only: ${failCtx}`;
    try {
      const retrySubtasks = await decompose(replanTask, model, verbose);
      const retryStates = await runWorkers({
        subtasks: retrySubtasks,
        workDir,
        model: workerModel,
        orchModel: model,
        parallel,
        verbose,
        onUpdate,
      });
      retryStates.forEach((v, k) => states.set(k + 1000, v));
    } catch (e: any) {
      console.error(chalk.red(`Re-plan failed: ${e.message}`));
    }
  }
  dashboard.update(states);

  const doneResults = Array.from(states.values())
    .filter((s) => s.status === 'done')
    .map((s) => ({ id: s.taskId, title: s.title, result: s.result || '' }));

  const errors = Array.from(states.values()).filter((s) => s.status === 'error');

  console.log('');
  if (doneResults.length > 0) {
    console.log(chalk.cyan('→ Synthesizing final report...'));
    const finalReport = await synthesize(task, doneResults, model);
    dashboard.finalize(finalReport);
  } else {
    dashboard.finalize(chalk.red('No subtasks completed successfully.'));
  }

  if (errors.length > 0) {
    console.log('');
    console.log(chalk.red(`Errors (${errors.length}):`));
    for (const e of errors) {
      console.log(chalk.red(`  [${e.taskId}] ${e.title}: ${e.error}`));
    }
  }

  process.exit(errors.length > 0 && doneResults.length === 0 ? 1 : 0);
}

function areAllFinal(states: Map<number, WorkerState>): boolean {
  return Array.from(states.values()).every(
    (s) => s.status === 'done' || s.status === 'error'
  );
}

main().catch((err) => {
  console.error(chalk.red('Fatal:'), err);
  process.exit(1);
});
