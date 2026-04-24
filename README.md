# Forge

Multi-agent CLI coding tool. Give it a task — it spawns parallel AI agents that each handle a subtask, then synthesizes the results.

```
forge "add user authentication with JWT to this Express API" --parallel 4
```

```
Forge v0.1.0
Orchestrator: claude-sonnet-4-6 | Workers: claude-haiku-4-5 | Parallel: 4

→ Plan (4 subtasks):
  [1] Install JWT deps          (low)
  [2] Create auth middleware    (medium)
  [3] Add login/register routes (medium)
  [4] Add tests                 (low) [deps: 2,3]

[1] Install JWT deps        ██████████ 100%  done ✓   +3.2s
[2] Create auth middleware  ██████████ 100%  done ✓   +8.1s
[3] Add login/register      ██████████ 100%  done ✓   +9.4s
[4] Add tests               ██████████ 100%  done ✓   +5.7s

Tokens: 38,200 | Cost: ~$0.019 | Time: 12.3s
```

## Features

- **Parallel execution** — independent subtasks run simultaneously
- **Smart orchestration** — LLM decomposes task into subtasks with dependency graph
- **Context passing** — results from completed tasks flow to dependent workers as context
- **Any provider** — any OpenAI-compatible endpoint (OmniRouter, OpenRouter, Ollama, etc.)
- **Live dashboard** — real-time progress, token counts, per-agent status
- **Retry logic** — automatic exponential backoff on 429/503
- **Graceful shutdown** — Ctrl+C kills all child workers cleanly

## Install

```bash
git clone https://github.com/serter2069/forge
cd forge
npm install
npm run build
ln -sf "$(pwd)/bin/forge" ~/bin/forge
```

Requires Node.js 18+.

## Usage

```bash
# Basic
forge "create a REST API with CRUD for users"

# Custom directory
forge "add TypeScript support" --dir /path/to/project

# More parallel workers
forge "refactor auth module" --parallel 6

# Custom models
forge "add tests" \
  --model claude-sonnet-4-6 \
  --worker-model claude-haiku-4-5-20251001

# Dry run — show plan without executing
forge "big refactor" --dry-run

# Verbose output
forge "fix the bug" --verbose
```

## Options

```
--parallel N      max parallel workers (default: 3)
--model m         orchestrator model
--worker-model m  worker model
--dir path        working directory (default: cwd)
--dry-run         show decomposition plan only
--verbose         show raw LLM output
```

## Provider config

Forge uses any OpenAI-compatible API:

```bash
# OmniRouter / local proxy
export OMNIROUTER_URL=http://localhost:20128/v1
export OMNIROUTER_KEY=sk-...

# OpenRouter
export OMNIROUTER_URL=https://openrouter.ai/api/v1
export OMNIROUTER_KEY=sk-or-v1-...

# Ollama (local models)
export OMNIROUTER_URL=http://localhost:11434/v1
export OMNIROUTER_KEY=ollama

# Override models
export FORGE_ORCH_MODEL=gpt-4o
export FORGE_WORKER_MODEL=gpt-4o-mini
```

## Architecture

```
forge <task>
     │
     ▼
Orchestrator LLM — decomposes task, builds DAG
     │
     ▼
Worker Pool (parallel child processes)
  ├── Worker 1 ──► tool loop ──► result
  ├── Worker 2 ──► tool loop ──► result
  └── Worker 3 ──► waits for dep ──► result
     │
     ▼
Synthesizer LLM — aggregates, final report
```

Each worker is an independent Node.js process with a tool-calling agent loop.
Worker tools: `bash`, `read_file`, `write_file`, `list_files`, `search_code`, `finish`.

## License

MIT — see [LICENSE](LICENSE)
