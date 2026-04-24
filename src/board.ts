import * as fs from 'fs/promises';
import * as path from 'path';

export interface BoardMessage {
  id: number;
  taskId: number;
  taskTitle: string;
  channel: string;
  content: string;
  at: string;
}

interface Board {
  messages: BoardMessage[];
  nextId: number;
}

const BOARD_FILE = '.forge-board.json';
const LOCK_RETRIES = 10;
const LOCK_DELAY_MS = 50;

async function withBoard<T>(workDir: string, fn: (board: Board) => T): Promise<T> {
  const file = path.join(workDir, BOARD_FILE);
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      let board: Board;
      try {
        const raw = await fs.readFile(file, 'utf8');
        board = JSON.parse(raw);
      } catch {
        board = { messages: [], nextId: 1 };
      }
      const result = fn(board);
      await fs.writeFile(file, JSON.stringify(board, null, 2), 'utf8');
      return result;
    } catch {
      await new Promise((r) => setTimeout(r, LOCK_DELAY_MS * (i + 1)));
    }
  }
  throw new Error('board: failed to acquire after retries');
}

export async function postMessage(
  workDir: string,
  taskId: number,
  taskTitle: string,
  channel: string,
  content: string
): Promise<string> {
  const id = await withBoard(workDir, (board) => {
    const msgId = board.nextId++;
    board.messages.push({
      id: msgId,
      taskId,
      taskTitle,
      channel: channel || 'general',
      content,
      at: new Date().toISOString(),
    });
    return msgId;
  });
  return `OK: posted message #${id} to channel "${channel || 'general'}"`;
}

export async function readMessages(
  workDir: string,
  channel?: string,
  since?: number
): Promise<string> {
  const file = path.join(workDir, BOARD_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const board: Board = JSON.parse(raw);
    let msgs = board.messages;
    if (channel) msgs = msgs.filter((m) => m.channel === channel);
    if (since !== undefined) msgs = msgs.filter((m) => m.id > since);
    if (msgs.length === 0) return '(no messages)';
    return msgs
      .map((m) => `[#${m.id} ${m.at} task#${m.taskId} "${m.taskTitle}" @${m.channel}]\n${m.content}`)
      .join('\n\n');
  } catch {
    return '(board not available)';
  }
}
