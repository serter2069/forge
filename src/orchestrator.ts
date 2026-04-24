import { chat, isMockMode, textOf } from './llm';
import { Subtask } from './types';

const DECOMPOSE_PROMPT = (task: string) => `You are a task planner for a coding agent system.
Break down this coding task into 2-6 atomic subtasks.

Task: ${task}

Rules:
- Each subtask must be executable by a coding agent with bash + file tools
- Maximize parallelism: if tasks are independent, set deps: []
- Dependent tasks (e.g. tests depend on implementation) set deps: [id]
- Subtask titles must be specific (e.g. "Create package.json", not "Task 1")
- description must be detailed enough for an agent to execute without context

Return ONLY a JSON array with this exact schema, no other text:
[
  {
    "id": 1,
    "title": "Create package.json",
    "description": "Run npm init -y in the work directory. Add scripts: {start: 'node app.js'}.",
    "deps": [],
    "complexity": "low"
  }
]

Valid complexity values: "low" | "medium" | "high"`;

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start !== -1 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

function validateSubtasks(arr: any[]): Subtask[] {
  if (!Array.isArray(arr) || arr.length === 0) throw new Error('empty or non-array');
  const hasToolCalls = arr.every((s) => s && ('tool' in s || 'command' in s) && !('title' in s));
  if (hasToolCalls) throw new Error('LLM returned tool-call format instead of subtask plan');

  return arr.map((s, i) => {
    const id = Number(s.id ?? i + 1);
    const title = String(s.title ?? s.name ?? `Subtask ${id}`).slice(0, 60);
    const description = String(s.description ?? s.desc ?? s.instructions ?? title);
    const deps = Array.isArray(s.deps)
      ? s.deps.map((d: any) => Number(d)).filter(Number.isFinite)
      : [];
    const complexity = (['low', 'medium', 'high'].includes(s.complexity) ? s.complexity : 'medium') as Subtask['complexity'];
    return { id, title, description, deps, complexity };
  });
}

export function mockDecompose(task: string): Subtask[] {
  return [
    { id: 1, title: 'Setup project', description: `Initialize project structure for: ${task}`, deps: [], complexity: 'low' },
    { id: 2, title: 'Implement core', description: `Implement the main functionality for: ${task}`, deps: [1], complexity: 'medium' },
    { id: 3, title: 'Add tests', description: 'Add basic tests or verification script.', deps: [2], complexity: 'low' },
  ];
}

export async function decompose(task: string, model: string, verbose = false): Promise<Subtask[]> {
  if (isMockMode()) return mockDecompose(task);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await chat({
        model,
        max_tokens: 2048,
        temperature: 0,
        messages: [
          { role: 'user', content: DECOMPOSE_PROMPT(task) },
        ],
      });
      const text = textOf(resp.choices[0]?.message);
      if (verbose) console.error('[orchestrator] raw:', text.slice(0, 300));
      const json = extractJson(text);
      const parsed = JSON.parse(json);
      return validateSubtasks(parsed);
    } catch (err: any) {
      if (verbose) console.error(`[orchestrator] attempt ${attempt} failed:`, err.message);
      if (attempt === 2) return mockDecompose(task);
    }
  }
  return mockDecompose(task);
}

export async function synthesize(
  task: string,
  results: { id: number; title: string; result: string }[],
  model: string
): Promise<string> {
  if (isMockMode() || results.length === 0) {
    return results.map((r) => `• [${r.id}] ${r.title}: ${r.result}`).join('\n');
  }
  const joined = results.map((r) => `### [${r.id}] ${r.title}\n${r.result}`).join('\n\n');
  try {
    const resp = await chat({
      model,
      max_tokens: 800,
      temperature: 0,
      messages: [
        {
          role: 'user',
          content: `Task: ${task}\n\nResults from parallel agents:\n${joined}\n\nWrite a concise final report (max 8 lines): what was built, files created, how to run it.`,
        },
      ],
    });
    return textOf(resp.choices[0]?.message).trim();
  } catch (err: any) {
    return `[synthesis failed: ${err.message}]\n\n${joined}`;
  }
}
