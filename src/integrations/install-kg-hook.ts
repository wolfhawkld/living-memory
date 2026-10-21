import { existsSync, lstatSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const BEGIN = '<!-- living-memory:begin -->';
const END = '<!-- living-memory:end -->';
const CONFIG_IGNORE = '/_system/living-memory.local.json';
// Exact managed v1 bytes from 10691a9, independently retained in tests/fixtures/progressive-kg/.
const MANAGED_V1_SHA256 = '75b588e6f1aedc9fb31527ab0190c81f891b4476723a51c88c2502d9d5eaa16f';

export interface HookRuntimeDirectories {
  dataDir?: string;
  cliStateDir?: string;
}
interface RuntimeDirectories { dataDir: string; cliStateDir: string }

function validText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function loopbackUrl(value: unknown): string {
  try {
    if (!validText(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw new Error('serverUrl 必须是本机回环 HTTP 服务地址。'); }
}
function configuredRuntime(original: string | null): RuntimeDirectories | undefined {
  if (original === null) return undefined;
  try {
    const config: unknown = JSON.parse(original);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error();
    const value = config as Record<string, unknown>;
    if (!validText(value.projectRoot) || !isAbsolute(value.projectRoot)) throw new Error();
    loopbackUrl(value.serverUrl);
    const keys = Object.keys(value).sort().join(',');
    if (keys === 'projectRoot,serverUrl') return undefined;
    if (keys !== 'cliStateDir,dataDir,projectRoot,serverUrl,version' || value.version !== 2
      || !validText(value.dataDir) || !isAbsolute(value.dataDir)
      || !validText(value.cliStateDir) || !isAbsolute(value.cliStateDir)) throw new Error();
    return { dataDir: value.dataDir, cliStateDir: value.cliStateDir };
  } catch { throw new Error('已有本机钩子配置无效，未覆盖，请先核对版本和完整运行目录。'); }
}
function requestedRuntime(options: HookRuntimeDirectories | undefined): RuntimeDirectories | undefined {
  if (options === undefined) return undefined;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('运行目录参数必须完整成对提供。');
  const keys = Object.keys(options);
  if (keys.length === 0) return undefined;
  if (keys.some(key => !['dataDir', 'cliStateDir'].includes(key))
    || !validText(options.dataDir) || !validText(options.cliStateDir)) throw new Error('运行目录参数必须完整成对提供。');
  return { dataDir: resolve(options.dataDir), cliStateDir: resolve(options.cliStateDir) };
}

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

export function planHookInstall(rootPath: string, serverUrl = 'http://127.0.0.1:4317', lmRoot = projectRoot,
  runtimeOptions?: HookRuntimeDirectories) {
  const requested = requestedRuntime(runtimeOptions);
  const root = realpathSync(rootPath);
  for (const path of ['AGENTS.md', 'SCHEMA.md', '_system/OPERATIONS.md']) {
    if (!existsSync(resolve(root, path))) throw new Error(`不是有效的 progressive-kg 根目录：缺少 ${path}`);
  }
  const url = loopbackUrl(serverUrl);
  const read = (path: string) => readTarget(root, path);
  const hook = readFileSync(new URL('../../integrations/progressive-kg/living_memory_hook.py', import.meta.url), 'utf8');
  const previousHook = read('_system/living_memory_hook.py');
  if (previousHook !== null && previousHook !== hook
    && createHash('sha256').update(previousHook).digest('hex') !== MANAGED_V1_SHA256) {
    throw new Error('已有同名钩子与本版本不同，未覆盖，请先核对已有修改。');
  }
  const fragment = readFileSync(new URL('../../integrations/progressive-kg/AGENTS.fragment.md', import.meta.url), 'utf8');
  const agents = read('AGENTS.md')!;
  const ignore = read('.gitignore') ?? '';
  const previousConfig = read('_system/living-memory.local.json');
  const existingRuntime = configuredRuntime(previousConfig);
  const runtime = requested ?? existingRuntime;
  const config = runtime ? { version: 2, projectRoot: realpathSync(lmRoot), serverUrl: url, ...runtime }
    : { projectRoot: realpathSync(lmRoot), serverUrl: url };
  const files: HookFileChange[] = [
    { relativePath: 'AGENTS.md', before: agents, after: managedBlock(agents, fragment), private: false },
    { relativePath: '.gitignore', before: read('.gitignore'),
      after: ignore.split(/\r?\n/).includes(CONFIG_IGNORE) ? ignore : `${ignore.trimEnd()}\n${CONFIG_IGNORE}\n`, private: false },
    { relativePath: '_system/living_memory_hook.py', before: previousHook,
      after: hook, private: false },
    { relativePath: '_system/living-memory.local.json', before: previousConfig,
      after: `${JSON.stringify(config, null, 2)}\n`, private: true },
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
    'data-dir': { type: 'string' }, 'state-dir': { type: 'string' },
  } });
  if (values.help) {
    process.stdout.write('安装成功流程的刷新钩子（不写知识正文或学习记录）：\n  npm run install:kg-hook -- --root ../progressive-kg [--url http://127.0.0.1:4317] [--data-dir /private/instance/data --state-dir /private/instance/cli] [--check]\n运行目录必须成对提供，会话路径固定为 data-dir/cli-session.json；省略时保留已有合法 v2 目录或沿用旧环境。\n--check 仅列出计划改动，不读取凭据或创建运行目录。实际安装前暂停 KG 调用；文件逐个原子替换，非跨文件事务。\n机器路径保存在被 Git 忽略的本地配置中。\n');
    return;
  }
  if (!values.root) throw new Error('请通过 --root 指定 progressive-kg 目录。');
  const runtime = values['data-dir'] !== undefined || values['state-dir'] !== undefined
    ? { dataDir: values['data-dir'], cliStateDir: values['state-dir'] } : undefined;
  const plan = planHookInstall(values.root, values.url, projectRoot, runtime);
  if (!values.check) applyHookInstall(plan);
  process.stdout.write(`${JSON.stringify({ status: values.check ? 'planned' : 'installed',
    files: plan.files.map(({ relativePath, private: local }) => ({ path: relativePath, localOnly: local })) }, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { main(); } catch {
    process.stderr.write(`${JSON.stringify({ error: { code: 'HOOK_INSTALL_FAILED', message: '钩子安装失败，请核对目录、配置版本和受管理文件。' } })}\n`);
    process.exitCode = 1;
  }
}
