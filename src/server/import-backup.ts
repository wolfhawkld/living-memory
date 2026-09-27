import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExportData } from '../shared/types.js';
import { StoreError } from './store.js';

/** Paths are server-owned; a backup contains only the importing account's namespace. */
export function saveImportBackup(dbPath: string, namespace: string, data: ExportData, purpose: 'import' | 'identity' = 'import'): string {
  const scope = createHash('sha256').update(namespace).digest('hex').slice(0, 24);
  const directory = join(dirname(dbPath), `${purpose}-backups`, scope);
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, name), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch {
    throw new StoreError(`${purpose.toUpperCase()}_BACKUP_FAILED`, '操作前备份保存失败，学习数据尚未修改。请检查本地存储后重试。', 503);
  }
  return `${scope}/${name}`;
}
