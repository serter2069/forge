import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolDef } from './llm';
import { registerFile, readManifest } from './manifest';
import { postMessage, readMessages } from './board';

const execAsync = promisify(exec);

const BASH_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 8000;

function truncate(s: string, max = MAX_OUTPUT_CHARS): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n...[truncated ${s.length - max} chars]`;
}

function resolveIn(workDir: string, target: string): string {
  return path.isAbsolute(target) ? target : path.join(workDir, target);
}

export async function bash(workDir: string, command: string): Promise<string> {
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: workDir,
      timeout: BASH_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
      shell: '/bin/bash',
    });
    const combined = (stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : '');
    return truncate(combined || '(no output)');
  } catch (err: any) {
    const out = (err.stdout || '') + (err.stderr ? `\n[stderr]\n${err.stderr}` : '');
    const msg = err.killed
      ? `[bash killed — timeout ${BASH_TIMEOUT_MS}ms]`
      : `[bash exit ${err.code}]`;
    return truncate(`${msg}\n${out || err.message || ''}`);
  }
}

export async function readFile(
  workDir: string,
  filePath: string,
  offset = 0,
  limit = MAX_OUTPUT_CHARS
): Promise<string> {
  try {
    const abs = resolveIn(workDir, filePath);
    const content = await fs.readFile(abs, 'utf8');
    const total = content.length;
    const slice = content.slice(offset, offset + limit);
    const remaining = total - offset - slice.length;
    const header = offset > 0 ? `[offset=${offset}, total=${total}]\n` : '';
    const footer = remaining > 0 ? `\n...[${remaining} more chars — use offset=${offset + slice.length} to continue]` : '';
    return header + slice + footer;
  } catch (err: any) {
    return `[read_file error] ${err.message}`;
  }
}

export async function writeFile(
  workDir: string,
  filePath: string,
  content: string,
  taskId = -1,
  taskTitle = ''
): Promise<string> {
  try {
    const abs = resolveIn(workDir, filePath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    if (taskId >= 0) await registerFile(workDir, filePath, taskId, taskTitle);
    return `OK: wrote ${content.length} bytes to ${filePath}`;
  } catch (err: any) {
    return `[write_file error] ${err.message}`;
  }
}

export async function getManifest(workDir: string): Promise<string> {
  return readManifest(workDir);
}

export async function boardPost(
  workDir: string,
  taskId: number,
  taskTitle: string,
  channel: string,
  content: string
): Promise<string> {
  return postMessage(workDir, taskId, taskTitle, channel, content);
}

export async function boardRead(
  workDir: string,
  channel?: string,
  since?: number
): Promise<string> {
  return readMessages(workDir, channel, since);
}

export async function listFiles(
  workDir: string,
  dir: string,
  pattern?: string
): Promise<string> {
  try {
    const abs = resolveIn(workDir, dir || '.');
    const entries = await fs.readdir(abs, { withFileTypes: true });
    let names = entries.map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    if (pattern) {
      const re = new RegExp(pattern);
      names = names.filter((n) => re.test(n));
    }
    return truncate(names.join('\n') || '(empty)');
  } catch (err: any) {
    return `[list_files error] ${err.message}`;
  }
}

export async function searchCode(
  workDir: string,
  query: string,
  dir: string
): Promise<string> {
  const target = resolveIn(workDir, dir || '.');
  const escaped = query.replace(/'/g, `'\\''`);
  const cmd = `grep -rn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist '${escaped}' '${target}' 2>/dev/null | head -50`;
  return bash(workDir, cmd);
}

// OpenAI tool definitions (function calling)
export const TOOL_DEFINITIONS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description:
        'Execute a shell command in the working directory. Timeout 30s. Returns combined stdout+stderr.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to run' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file. Path relative to work dir or absolute. For large files: use offset+limit to paginate (default limit=8000 chars). Footer shows remaining chars and the next offset to use.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          offset: { type: 'number', description: 'Start reading from this char offset (default 0)' },
          limit: { type: 'number', description: 'Max chars to return (default 8000)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a file. Creates directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in a directory. Optional regex pattern to filter.',
      parameters: {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          pattern: { type: 'string' },
        },
        required: ['dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_code',
      description: 'Grep-search code in directory. Returns matching lines.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          dir: { type: 'string' },
        },
        required: ['query', 'dir'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'manifest',
      description:
        'Show the shared manifest of all files created so far by all parallel agents in this session. Use before writing to avoid conflicts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_post',
      description:
        'Post a message to the shared agent blackboard so other parallel agents can read it. Use to announce what you built, share interfaces, or coordinate. channel: e.g. "api", "schema", "general".',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Message channel (e.g. "api", "schema", "general")' },
          content: { type: 'string', description: 'Message content — what you built, what interface/contract others should use' },
        },
        required: ['channel', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'board_read',
      description:
        'Read messages from the shared agent blackboard posted by other parallel agents. Use to learn what others built before you start, to avoid conflicts and stay in sync.',
      parameters: {
        type: 'object',
        properties: {
          channel: { type: 'string', description: 'Filter by channel (optional, omit for all channels)' },
          since: { type: 'number', description: 'Only return messages with id > this value (optional)' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'spawn_agent',
      description:
        'Spawn a sub-agent to handle a sub-task autonomously. The sub-agent runs in the same work directory, has the same tools, and returns a result. Use for complex sub-problems that can be parallelized or isolated.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Full description of the sub-task' },
          parallel: { type: 'number', description: 'Max parallel workers for sub-agent (default 2)' },
        },
        required: ['task'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description:
        'Call when the task is fully complete. Provide a concise summary of what was accomplished.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
];

export async function runTool(
  workDir: string,
  name: string,
  input: any,
  taskId = -1,
  taskTitle = ''
): Promise<string> {
  const n = String(name || '').toLowerCase();
  switch (n) {
    case 'bash':
      return bash(workDir, String(input?.command ?? ''));
    case 'read_file':
    case 'readfile':
      return readFile(
        workDir,
        String(input?.path ?? ''),
        input?.offset !== undefined ? Number(input.offset) : 0,
        input?.limit !== undefined ? Number(input.limit) : MAX_OUTPUT_CHARS
      );
    case 'write_file':
    case 'writefile':
      return writeFile(workDir, String(input?.path ?? ''), String(input?.content ?? ''), taskId, taskTitle);
    case 'list_files':
    case 'listfiles':
      return listFiles(workDir, String(input?.dir ?? '.'), input?.pattern);
    case 'search_code':
    case 'searchcode':
      return searchCode(workDir, String(input?.query ?? ''), String(input?.dir ?? '.'));
    case 'manifest':
      return getManifest(workDir);
    case 'board_post':
    case 'boardpost':
      return boardPost(workDir, taskId, taskTitle, String(input?.channel ?? 'general'), String(input?.content ?? ''));
    case 'board_read':
    case 'boardread':
      return boardRead(workDir, input?.channel ? String(input.channel) : undefined, input?.since !== undefined ? Number(input.since) : undefined);
    default:
      return `[unknown tool: ${name}]`;
  }
}

export function isFinishTool(name: string): boolean {
  return String(name || '').toLowerCase() === 'finish';
}
