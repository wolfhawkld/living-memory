import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { backupInstance, verifyInstanceBundle, restoreInstance, activateRestoredConnectors,
  type BackupInstanceOptions, type InstanceManifest, type RestoreReport } from '../src/server/instance-backup.js';

type BackupOptions = Pick<BackupInstanceOptions, 'dataDir' | 'kgRoot' | 'cliStateDir' | 'output' | 'envFile' | 'cliSessionFile' | 'offlineCheck'>;
export interface InstanceBackupCliBackend {
  backupInstance: (options: BackupOptions) => Promise<InstanceManifest>;
  verifyInstanceBundle: (bundle: string) => InstanceManifest;
  restoreInstance: (options: { bundle: string; target: string }) => Promise<RestoreReport>;
  activateRestoredConnectors: (dataDir: string, confirmed: boolean, options?: { offlineCheck?: 'native' | 'sudo' }) => Promise<void>;
}
const backend: InstanceBackupCliBackend = { backupInstance, verifyInstanceBundle, restoreInstance, activateRestoredConnectors };
const HELP = `Living Memory 完整实例离线迁移

node --import tsx scripts/instance-backup.ts backup --data-dir <目录> --kg-root <目录> --cli-state-dir <目录> --output <新目录> [--env-file <文件>] [--cli-session-file <文件>] [--sudo-offline-scan]
node --import tsx scripts/instance-backup.ts verify --bundle <备份目录>
node --import tsx scripts/instance-backup.ts restore --bundle <备份目录> --target <新目录>
node --import tsx scripts/instance-backup.ts activate-connectors --data-dir <恢复后的data目录> --confirm-bindings [--sudo-offline-scan]

备份和激活前必须停止本地服务、飞书连接及其他数据库使用进程；不会自动终止进程。
目标必须是新目录；源、目标和静态资源路径隔离由后端核验。
浏览器待同步请求和未提交草稿不在备份中，迁移前请自行核对。
恢复保持连接器隔离；不会自动激活飞书，需停服后显式确认绑定。
仅当前 Linux/WSL 离线检查流程；Windows 完整迁移待验证。
遇到 systemd/PAM 的受限文件描述符，可显式选择 --sudo-offline-scan，仅给只读扫描辅助器提权。
请在可信源码目录以原账号运行命令；sudo 密码只在本机终端输入，备份与服务不以 root 运行。
`;
class CliArgumentError extends Error { constructor(readonly code: string) { super(code); } }
const CODES = new Set(['INVALID_INSTANCE_ARGUMENT', 'INVALID_INSTANCE_COMMAND', 'CONNECTOR_CONFIRMATION_REQUIRED',
  'UNSAFE_INSTANCE_PATH', 'UNSAFE_INSTANCE_FILE', 'INSTANCE_SOURCE_CHANGED', 'INSTANCE_LIMIT_EXCEEDED', 'INSTANCE_DATABASE_INVALID',
  'INSTANCE_DATABASE_MISSING', 'INSTANCE_TARGET_EXISTS', 'INSTANCE_MANIFEST_INVALID', 'INSTANCE_HASH_MISMATCH', 'INSTANCE_SOURCE_INVALID',
  'RESTORE_QUARANTINE_NOT_PRESENT', 'RESTORE_QUARANTINE_INVALID', 'DATA_DIRECTORY_BUSY', 'DATA_DIRECTORY_LOCK_UNKNOWN',
  'OFFLINE_CHECK_UNAVAILABLE', 'OFFLINE_SCAN_AUTH_REQUIRED', 'OFFLINE_SCAN_UNAVAILABLE', 'DATABASE_OPEN', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC']);
export function instanceBackupErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && CODES.has(code) ? code : 'INSTANCE_BACKUP_FAILED';
}
function parse(argv: readonly string[]): { command: string; flags: Map<string, string | true> } | null {
  if (!argv.length || (argv.length === 1 && ['help', '--help', '-h'].includes(argv[0]))
    || (argv.length === 2 && ['backup', 'verify', 'restore', 'activate-connectors'].includes(argv[0]) && argv[1] === '--help')) return null;
  const command = argv[0];
  const allowed: Record<string, readonly string[]> = {
    backup: ['data-dir', 'kg-root', 'cli-state-dir', 'output', 'env-file', 'cli-session-file', 'sudo-offline-scan'],
    verify: ['bundle'], restore: ['bundle', 'target'], 'activate-connectors': ['data-dir', 'confirm-bindings', 'sudo-offline-scan'],
  };
  if (!Object.hasOwn(allowed, command)) throw new CliArgumentError('INVALID_INSTANCE_COMMAND');
  const flags = new Map<string, string | true>();
  for (let index = 1; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match || !allowed[command].includes(match[1]) || flags.has(match[1])) throw new CliArgumentError('INVALID_INSTANCE_ARGUMENT');
    if (match[1] === 'confirm-bindings' || match[1] === 'sudo-offline-scan') {
      if (match[2] !== undefined) throw new CliArgumentError('INVALID_INSTANCE_ARGUMENT');
      flags.set(match[1], true); continue;
    }
    const value = match[2] ?? argv[++index];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000]/.test(value)) throw new CliArgumentError('INVALID_INSTANCE_ARGUMENT');
    flags.set(match[1], value);
  }
  return { command, flags };
}
/** Whitelisted public summary; manifests and environment contents never print. */
export async function runInstanceBackupCli(argv: readonly string[], implementation: InstanceBackupCliBackend = backend): Promise<Record<string, unknown> | string> {
  const parsed = parse(argv); if (!parsed) return HELP;
  const required = (name: string): string => {
    const value = parsed.flags.get(name); if (typeof value !== 'string') throw new CliArgumentError('INVALID_INSTANCE_ARGUMENT'); return value;
  };
  const optional = (name: string): string | undefined => { const value = parsed.flags.get(name); return typeof value === 'string' ? value : undefined; };
  if (parsed.command === 'backup') {
    const output = required('output');
    const options: BackupOptions = { dataDir: required('data-dir'), kgRoot: required('kg-root'), cliStateDir: required('cli-state-dir'), output,
      ...(optional('env-file') !== undefined ? { envFile: optional('env-file') } : {}),
      ...(optional('cli-session-file') !== undefined ? { cliSessionFile: optional('cli-session-file') } : {}),
      ...(parsed.flags.has('sudo-offline-scan') ? { offlineCheck: 'sudo' as const } : {}) };
    const manifest = await implementation.backupInstance(options);
    return { format: 'living-memory-instance', version: 1, status: 'created', files: manifest.files.length, sources: manifest.sources.length, target: output };
  }
  if (parsed.command === 'verify') {
    const manifest = implementation.verifyInstanceBundle(required('bundle'));
    return { format: 'living-memory-instance', version: 1, status: 'verified', files: manifest.files.length, sources: manifest.sources.length };
  }
  if (parsed.command === 'restore') {
    const target = required('target'); const restored = await implementation.restoreInstance({ bundle: required('bundle'), target });
    return { format: 'living-memory-restore-report', version: 1, status: 'restored-quarantined', target, files: restored.files, sources: restored.sources,
      connectorsBlocked: true, startup: { dataDir: restored.startup.dataDir, kgRoot: restored.startup.kgRoot, cliStateDir: restored.startup.cliStateDir, envArchive: restored.startup.envArchive } };
  }
  const dataDir = required('data-dir');
  if (parsed.flags.get('confirm-bindings') !== true) throw new CliArgumentError('CONNECTOR_CONFIRMATION_REQUIRED');
  if (parsed.flags.has('sudo-offline-scan')) await implementation.activateRestoredConnectors(dataDir, true, { offlineCheck: 'sudo' });
  else await implementation.activateRestoredConnectors(dataDir, true);
  return { format: 'living-memory-connectors-activation', version: 1, status: 'activated', dataDir };
}
export async function instanceBackupMain(argv: readonly string[], io: { stdout: (value: string) => void; stderr: (value: string) => void },
  implementation: InstanceBackupCliBackend = backend): Promise<number> {
  try { const result = await runInstanceBackupCli(argv, implementation); io.stdout(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`); return 0; }
  catch (error) { io.stderr(`${JSON.stringify({ error: { code: instanceBackupErrorCode(error) } })}\n`); return 1; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await instanceBackupMain(process.argv.slice(2), { stdout: (value) => { process.stdout.write(value); }, stderr: (value) => { process.stderr.write(value); } });
}
