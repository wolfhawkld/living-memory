import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { StoreError } from './store.js';

/** Resolve existing ancestors too, so not-yet-created directories cannot hide a symlink overlap. */
function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(canonical(parent), relative(parent, absolute));
}

function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'));
}

function overlaps(first: string, second: string): boolean {
  return contains(first, second) || contains(second, first);
}

export function validateStoragePaths(options: { root: string; dataDir: string; staticDir: string; accountsEnabled: boolean; dbPath?: string }): void {
  const root = canonical(options.root);
  const data = canonical(options.dataDir);
  const assets = canonical(options.staticDir);
  if (options.accountsEnabled && overlaps(root, data)) {
    throw new StoreError('UNSAFE_STORAGE_PATH', '账号模式下，知识源与账号数据目录必须相互独立，不能包含彼此。');
  }
  // A missing static directory is not mounted by createApp (API-only tests and development).
  if (existsSync(options.staticDir) && (overlaps(assets, root) || overlaps(assets, data) || (options.dbPath && contains(assets, canonical(options.dbPath))))) {
    throw new StoreError('UNSAFE_STORAGE_PATH', '网页静态目录不能与知识源或私人数据目录重叠。');
  }
  if (!options.accountsEnabled && existsSync(join(data, 'accounts.sqlite'))) {
    throw new StoreError('ACCOUNTS_REQUIRED', '此数据目录已有账号库，请启用账号模式；单用户调试请使用独立的数据目录。');
  }
}
