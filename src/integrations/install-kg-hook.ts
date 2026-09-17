import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const BEGIN = '<!-- living-memory:begin -->';
const END = '<!-- living-memory:end -->';
const CONFIG_IGNORE = '/_system/living-memory.local.json';

export interface HookFileChange {
  relativePath: string;
  before: string | null;
  after: string;
  private: boolean;
}

function managedBlock(original: string, fragment: string): string {
  const start = original.indexOf(BEGIN);
  const end = original.indexOf(END);
  if (start < 0 && end < 0) return `${original.trimEnd()}\n\n${fragment.trim()}\n`;
  if (start < 0 || end < start || original.indexOf(BEGIN, start + BEGIN.length) >= 0
      || original.indexOf(END, end + END.length) >= 0) {
    throw new Error('AGENTS.md 的 Living Memory 标记不完整或重复，请先核对该段。');
  }
  if (original.slice(start, end + END.length).trim() !== fragment.trim()) {
    throw new Error('AGENTS.md 的 Living Memory 段落与本版本不同，未覆盖，请先核对已有修改。');
  }
  return original.slice(0, start) + fragment.trim() + original.slice(end + END.length);
}

function readTarget(root: string, path: string): string | null {
  const target = resolve(root, path);
  // Check the parent even when the destination has not been created yet.
  if (realpathSync(dirname(target)) !== dirname(target)) {
    throw new Error(`接入文件的目录不可通过符号链接指向其他位置：${path}`);
  }
  let metadata;
  try { metadata = lstatSync(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!metadata.isFile() || realpathSync(target) !== target) {
    throw new Error(`接入文件必须是知识库中的普通文件：${path}`);
  }
  return readFileSync(target, 'utf8');
}

export function planHookInstall(rootPath: string, serverUrl = 'http://127.0.0.1:4317', lmRoot = projectRoot) {
  const root = realpathSync(rootPath);
  for (const path of ['AGENTS.md', 'SCHEMA.md', '_system/OPERATIONS.md']) {
    if (!existsSync(resolve(root, path))) throw new Error(`不是有效的 progressive-kg 根目录：缺少 ${path}`);
  }
  const url = new URL(serverUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('serverUrl 必须是本机回环 HTTP 服务地址。');
  }
  const read = (path: string) => readTarget(root, path);
  const hook = readFileSync(new URL('../../integrations/progressive-kg/living_memory_hook.py', import.meta.url), 'utf8');
  const previousHook = read('_system/living_memory_hook.py');
  if (previousHook !== null && previousHook !== hook) {
    throw new Error('已有同名钩子与本版本不同，未覆盖，请先核对已有修改。');
  }
  const fragment = readFileSync(new URL('../../integrations/progressive-kg/AGENTS.fragment.md', import.meta.url), 'utf8');
  const agents = read('AGENTS.md')!;
  const ignore = read('.gitignore') ?? '';
  const files: HookFileChange[] = [
    { relativePath: 'AGENTS.md', before: agents, after: managedBlock(agents, fragment), private: false },
    { relativePath: '.gitignore', before: read('.gitignore'),
      after: ignore.split(/\r?\n/).includes(CONFIG_IGNORE) ? ignore : `${ignore.trimEnd()}\n${CONFIG_IGNORE}\n`, private: false },
    { relativePath: '_system/living_memory_hook.py', before: previousHook,
      after: hook, private: false },
    { relativePath: '_system/living-memory.local.json', before: read('_system/living-memory.local.json'),
      after: `${JSON.stringify({ projectRoot: realpathSync(lmRoot), serverUrl: url.origin }, null, 2)}\n`, private: true },
  ];
  return { root, files: files.filter((file) => file.before !== file.after) };
}

export function applyHookInstall(plan: ReturnType<typeof planHookInstall>): void {
  const assertUnchanged = () => {
    for (const change of plan.files) {
      if (readTarget(plan.root, change.relativePath) !== change.before) {
        throw new Error(`文件在准备后发生变化，未继续安装：${change.relativePath}`);
      }
    }
  };
  const prepared: { file: string; temp: string }[] = [];
  assertUnchanged();
  try {
    for (const change of plan.files) {
      const file = resolve(plan.root, change.relativePath);
      const temp = `${file}.${randomUUID()}.tmp`;
      prepared.push({ file, temp });
      writeFileSync(temp, change.after, { encoding: 'utf8', mode: change.private ? 0o600 : 0o644, flag: 'wx' });
    }
    assertUnchanged();
    // Each file is atomic. If a rename fails, rerunning safely completes the installation.
    for (const { file, temp } of prepared) renameSync(temp, file);
  } finally {
    for (const { temp } of prepared) {
      try { unlinkSync(temp); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

function main(): void {
  const { values } = parseArgs({ options: {
    root: { type: 'string' }, url: { type: 'string' }, check: { type: 'boolean' }, help: { type: 'boolean' },
  } });
  if (values.help) {
    process.stdout.write('安装成功流程的刷新钩子（不写知识正文或学习记录）：\n  npm run install:kg-hook -- --root ../progressive-kg [--url http://127.0.0.1:4317] [--check]\n--check 仅列出计划改动。机器路径保存在被 Git 忽略的本地配置中。\n');
    return;
  }
  if (!values.root) throw new Error('请通过 --root 指定 progressive-kg 目录。');
  const plan = planHookInstall(values.root, values.url);
  if (!values.check) applyHookInstall(plan);
  process.stdout.write(`${JSON.stringify({ status: values.check ? 'planned' : 'installed',
    files: plan.files.map(({ relativePath, private: local }) => ({ path: relativePath, localOnly: local })) }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: { code: 'HOOK_INSTALL_FAILED', message: error instanceof Error ? error.message : String(error) } })}\n`);
    process.exitCode = 1;
  }
}
