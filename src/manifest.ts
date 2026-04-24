import * as fs from 'fs/promises';
import * as path from 'path';

export interface ManifestEntry {
  path: string;
  taskId: number;
  taskTitle: string;
  at: string;
}

export interface Manifest {
  task: string;
  startedAt: string;
  entries: ManifestEntry[];
}

const MANIFEST_FILE = '.forge-manifest.json';

export async function initManifest(workDir: string, task: string): Promise<void> {
  const file = path.join(workDir, MANIFEST_FILE);
  const manifest: Manifest = { task, startedAt: new Date().toISOString(), entries: [] };
  await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
}

export async function registerFile(
  workDir: string,
  filePath: string,
  taskId: number,
  taskTitle: string
): Promise<void> {
  const file = path.join(workDir, MANIFEST_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const manifest: Manifest = JSON.parse(raw);
    // dedup
    manifest.entries = manifest.entries.filter((e) => e.path !== filePath);
    manifest.entries.push({ path: filePath, taskId, taskTitle, at: new Date().toISOString() });
    await fs.writeFile(file, JSON.stringify(manifest, null, 2), 'utf8');
  } catch {
    // manifest missing — skip silently
  }
}

export async function readManifest(workDir: string): Promise<string> {
  const file = path.join(workDir, MANIFEST_FILE);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const manifest: Manifest = JSON.parse(raw);
    if (manifest.entries.length === 0) return '(no files registered yet)';
    return manifest.entries
      .map((e) => `  ${e.path} — created by task #${e.taskId} "${e.taskTitle}"`)
      .join('\n');
  } catch {
    return '(manifest not available)';
  }
}
