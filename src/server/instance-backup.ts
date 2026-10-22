import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { acquireDataDirectoryLock } from './data-directory-lock.js';
import { createOfflineScanner, type OfflineScanner } from './offline-scan.js';
import { parseSourceIdentityRegistry, readSourceIdentityRegistry, resolveSourceIdentity, type SourceIdentityRegistry } from './source-identities.js';
import { isRestoreQuarantined, readInstanceId, type InstanceIdentity, type RestoreQuarantine } from './instance-state.js';
import { isValidInstant } from '../core/time-model.js';
import { isValidFeishuReviewState } from './accounts.js';
import { inspectLearningSchema, migrateLearningSchemaV1ToV2 } from './learning-schema.js';
import { inspectAnswerClearingSchemaV3 } from './answer-clearing-schema.js';
import { copyLearningSchemaV2ToV3 } from './answer-clearing-migration.js';

const MAX_FILES = 100_000, MAX_FILE_BYTES = 256 * 1024 * 1024, MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
const applicationVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const LEGACY_APPLICATION_VERSION = '0.0.1-preview.1';
const CURRENT_APPLICATION_VERSION = '0.0.1-preview.2';
const hash = (content: Uint8Array | string) => createHash('sha256').update(content).digest('hex');
export class InstanceBackupError extends Error {
  constructor(readonly code: string) { super(`${code}: 完整实例操作未完成，请核对离线状态、路径及备份清单。`); this.name = 'InstanceBackupError'; }
}
interface FileEntry { path: string; size: number; sha256: string }
interface DatabaseEntry { path: string; userVersion: number; schemaHash: string; tables: Record<string, number> }
interface SourceEntry { role: 'owner' | 'member'; userId: string | null; identityHash: string; namespace: string; directory: string; displayName: string }
export interface InstanceManifestBase {
  format: 'living-memory-instance'; createdAt: string; instanceId: string;
  files: FileEntry[]; databases: DatabaseEntry[]; sources: SourceEntry[]; configuration: string[]; excluded: string[];
  browserState: 'not-included';
}
export interface InstanceManifestV1 extends InstanceManifestBase {
  version: 1; applicationVersion: typeof LEGACY_APPLICATION_VERSION; learningSchemaVersion?: never;
}
export interface InstanceManifestV2 extends InstanceManifestBase {
  version: 2; applicationVersion: typeof CURRENT_APPLICATION_VERSION; learningSchemaVersion: 1 | 2 | 3;
}
export type InstanceManifest = InstanceManifestV1 | InstanceManifestV2;
export interface BackupInstanceOptions {
  dataDir: string; kgRoot: string; cliStateDir: string; output: string; envFile?: string; cliSessionFile?: string;
  offlineCheck?: 'native' | 'sudo';
  /** Only synthetic tests substitute proc; production always inspects real /proc. */
  procRoot?: string; now?: () => Date;
}
export interface RestoreReport {
  format: 'living-memory-restore-report'; version: 1; restoredAt: string; instanceId: string;
  files: number; sources: number; invalidated: Record<string, number>; connectorsBlocked: true;
  browserState: 'not-included'; startup: { dataDir: string; kgRoot: string; cliStateDir: string; envArchive: string | null };
  schemaMigrations: string[];
  /** Offline candidate only: current product Store and HTTP protocol still reject schema 3. */
  learningSchemaCandidate?: { schemaVersion: 3; runtimeReady: false };
}
export interface RestoreInstanceOptions {
  bundle: string; target: string; now?: () => Date; preserveLegacyLearningSchema?: boolean;
  targetLearningSchemaVersion?: 2 | 3;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute));
}
function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'));
}
function ensureSeparate(target: string, sources: readonly string[]) {
  const destination = canonical(target);
  for (const path of [...sources, resolve(process.cwd(), 'dist')]) {
    const source = canonical(path);
    if (contains(source, destination) || contains(destination, source)) throw new InstanceBackupError('UNSAFE_INSTANCE_PATH');
  }
}
function safeRelative(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 4096 && !isAbsolute(path)
    && !/[\\:\u0000-\u001f\u007f]/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..');
}
function ordinaryDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
}
function readOrdinary(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
  const content = readFileSync(path);
  if (content.length !== stat.size || content.length > MAX_FILE_BYTES) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
  return content;
}
function writePrivate(path: string, value: Uint8Array | string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
}
function inventory(root: string, prefix = '', skip: (relative: string) => boolean = () => false): FileEntry[] {
  ordinaryDirectory(root);
  const result: FileEntry[] = []; let bytes = 0;
  const visit = (directory: string, suffix: string) => {
    for (const entry of readdirSync(directory).sort()) {
      const name = suffix ? `${suffix}/${entry}` : entry;
      if (skip(name)) continue;
      if (!safeRelative(name)) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
      const absolute = join(root, name), stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
      if (stat.isDirectory()) visit(absolute, name);
      else {
        const content = readOrdinary(absolute); bytes += content.length;
        result.push({ path: prefix ? `${prefix}/${name}` : name, size: content.length, sha256: hash(content) });
        if (result.length > MAX_FILES || bytes > MAX_TOTAL_BYTES) throw new InstanceBackupError('INSTANCE_LIMIT_EXCEEDED');
      }
    }
  };
  visit(root, ''); return result;
}
function sameFiles(left: FileEntry[], right: FileEntry[]) { return JSON.stringify(left) === JSON.stringify(right); }
function copyInventory(source: string, destination: string, entries: FileEntry[], prefix = '') {
  for (const entry of entries) {
    const suffix = prefix ? entry.path.slice(prefix.length + 1) : entry.path;
    const content = readOrdinary(join(source, suffix));
    if (content.length !== entry.size || hash(content) !== entry.sha256) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
    writePrivate(join(destination, entry.path), content);
  }
}
function sqlName(name: string) { return `"${name.replaceAll('"', '""')}"`; }
function databaseInfo(path: string, relativePath: string): DatabaseEntry {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const tables: Record<string, number> = Object.create(null);
    for (const row of schema) if (row.type === 'table') tables[String(row.name)] = Number(db.prepare(`SELECT count(*) AS count FROM ${sqlName(String(row.name))}`).get()!.count);
    return { path: relativePath, userVersion: Number(db.prepare('PRAGMA user_version').get()!.user_version), schemaHash: hash(JSON.stringify(schema)), tables };
  } finally { db.close(); }
}
function learningSchemaVersion(path: string): 1 | 2 | 3 {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (db.prepare('PRAGMA main.user_version').get()!.user_version === 3) {
      if (inspectAnswerClearingSchemaV3(db).kind !== 'current-v3') throw new Error();
      return 3;
    }
    const schema = inspectLearningSchema(db);
    if (schema.kind !== 'legacy-v1' && schema.kind !== 'current-v2') throw new Error();
    return schema.schemaVersion;
  } catch { throw new InstanceBackupError('INSTANCE_DATABASE_INVALID'); }
  finally { db?.close(); }
}
function validateDatabases(root: string, databases: DatabaseEntry[]) {
  if (!databases.some((entry) => entry.path === 'data/living-memory.sqlite')) throw new InstanceBackupError('INSTANCE_DATABASE_MISSING');
  const paths = new Set<string>();
  for (const entry of databases) {
    if (!['data/living-memory.sqlite', 'data/accounts.sqlite'].includes(entry.path) || paths.has(entry.path)) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    paths.add(entry.path);
    const actual = databaseInfo(join(root, entry.path), entry.path);
    if (JSON.stringify(actual) !== JSON.stringify(entry)) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    const required = entry.path === 'data/accounts.sqlite' ? ['accounts', 'sessions', 'meta', 'feishu_bindings', 'feishu_binding_requests', 'feishu_card_views', 'feishu_review_sessions', 'feishu_review_operations', 'feishu_read_receipts']
      : ['namespaces', 'config_history', 'anchors', 'observations', 'retentions', 'applications', 'corrections', 'relation_reviews', 'practice_cards', 'practice_attempts',
        'practice_card_sources', 'layouts', 'review_plans', 'imported_concepts', 'identity_catalog', 'identity_bindings', 'import_receipts'];
    if (required.some((name) => !Object.hasOwn(actual.tables, name))) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    if (entry.path === 'data/living-memory.sqlite') {
      const count = ['activity_settings', 'activity_events', 'activity_deliveries', 'activity_deletions'].filter((name) => Object.hasOwn(actual.tables, name)).length;
      if (count !== 0 && count !== 4) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    }
  }
}
function publish(stage: string, target: string) {
  // mkdir fails if any target already exists; rename publishes only after the
  // staged instance is complete. The reservation remains empty and private.
  mkdirSync(target, { mode: 0o700 });
  try { renameSync(stage, target); }
  catch (error) { try { rmdirSync(target); } catch { /* never remove nonempty external content */ } throw error; }
}
function newStage(target: string): string {
  if (existsSync(target)) throw new InstanceBackupError('INSTANCE_TARGET_EXISTS');
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const stage = join(dirname(target), `.${relative(dirname(target), target)}.lm-${randomUUID()}.tmp`);
  mkdirSync(stage, { mode: 0o700 }); return stage;
}

function databasePaths(dataDir: string): string[] {
  return ['living-memory.sqlite', 'accounts.sqlite'].flatMap((name) => ['', '-wal', '-shm', '-journal'].map((suffix) => join(dataDir, name + suffix)));
}
function mainDatabaseIdentities(dataDir: string): string {
  return JSON.stringify(['living-memory.sqlite', 'accounts.sqlite'].map((name) => {
    const path = join(dataDir, name);
    if (!existsSync(path)) return [name, null];
    const stat = lstatSync(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
    return [name, stat.dev.toString(), stat.ino.toString()];
  }));
}

/** Offline, local, private directory bundle. Never mutates source knowledge. */
export async function backupInstance(options: BackupInstanceOptions): Promise<InstanceManifestV2> {
  const dataDir = canonical(options.dataDir), kgRoot = canonical(options.kgRoot), cli = canonical(options.cliStateDir), output = canonical(options.output);
  ordinaryDirectory(dataDir); ordinaryDirectory(kgRoot);
  ensureSeparate(output, [dataDir, kgRoot, cli, ...(options.envFile ? [options.envFile] : []), ...(options.cliSessionFile ? [options.cliSessionFile] : [])]);
  if (contains(dataDir, kgRoot) || contains(kgRoot, dataDir)) throw new InstanceBackupError('UNSAFE_INSTANCE_PATH');
  if (contains(cli, kgRoot) || contains(kgRoot, cli)) throw new InstanceBackupError('UNSAFE_INSTANCE_PATH');
  const lock = acquireDataDirectoryLock(dataDir); let stage: string | null = null; let scanner: OfflineScanner | null = null; let operationFailed = false;
  try {
    const databaseNames = ['living-memory.sqlite', ...(existsSync(join(dataDir, 'accounts.sqlite')) ? ['accounts.sqlite'] : [])];
    if (!existsSync(join(dataDir, databaseNames[0]))) throw new InstanceBackupError('INSTANCE_DATABASE_MISSING');
    const mainIdentities = mainDatabaseIdentities(dataDir);
    scanner = await createOfflineScanner({ mode: options.offlineCheck, dataDir, procRoot: options.procRoot });
    await scanner.scan(databasePaths(dataDir));
    if (applicationVersion !== CURRENT_APPLICATION_VERSION) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
    const schemaVersion = learningSchemaVersion(join(dataDir, 'living-memory.sqlite'));
    stage = newStage(output);
    const excluded: string[] = ['browser pending writes and drafts', 'runtime leases', 'old CLI session secrets'];
    const sources: SourceEntry[] = []; const configuration: string[] = [];
    let ownerId: string | null = null;
    let members: string[] = [];
    if (databaseNames.includes('accounts.sqlite')) {
      const accounts = new DatabaseSync(join(dataDir, 'accounts.sqlite'), { readOnly: true });
      try {
        ownerId = String(accounts.prepare("SELECT value FROM meta WHERE key='firstOwnerId'").get()?.value ?? '') || null;
        members = accounts.prepare('SELECT id FROM accounts ORDER BY id').all().map((row) => String(row.id)).filter((id) => id !== ownerId);
      }
      finally { accounts.close(); }
    }
    const kgSkip = (path: string) => path === '.git' || path.startsWith('.git/');
    const trees: { root: string; prefix: string; before: FileEntry[]; skip: (path: string) => boolean }[] = [];
    const addSource = (root: string, directory: string, role: SourceEntry['role'], userId: string | null) => {
      const identity = resolveSourceIdentity(dataDir, root);
      sources.push({ role, userId, identityHash: identity.identityHash, namespace: `kg_${identity.identityHash.slice(0, 48)}`, directory, displayName: identity.displayName });
      const before = inventory(root, directory, kgSkip); trees.push({ root, prefix: directory, before, skip: kgSkip });
      if (existsSync(join(root, '.git'))) excluded.push(`${directory}/.git`);
    };
    addSource(kgRoot, 'knowledge/owner', 'owner', ownerId);
    if (existsSync(join(dataDir, 'users'))) {
      ordinaryDirectory(join(dataDir, 'users'));
      for (const userId of readdirSync(join(dataDir, 'users')).sort()) {
        if (!/^[a-f0-9-]{36}$/.test(userId)) throw new InstanceBackupError('UNSAFE_INSTANCE_FILE');
        ordinaryDirectory(join(dataDir, 'users', userId));
        if (!members.includes(userId)) { excluded.push(`data/users/${userId}`); continue; }
        const root = join(dataDir, 'users', userId, 'knowledge');
        if (existsSync(root)) { ordinaryDirectory(root); addSource(root, `data/users/${userId}/knowledge`, 'member', userId); }
        for (const name of readdirSync(join(dataDir, 'users', userId))) if (name !== 'knowledge') excluded.push(`data/users/${userId}/${name}`);
      }
    }
    for (const userId of members) if (!sources.some((source) => source.role === 'member' && source.userId === userId)) {
      if (!/^[a-f0-9-]{36}$/.test(userId)) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
      const physicalRoot = canonical(join(dataDir, 'users', userId, 'knowledge'));
      const registered = readSourceIdentityRegistry(dataDir)?.entries.find((entry) => entry.physicalRoot === physicalRoot);
      const identityHash = registered?.identityHash ?? hash(physicalRoot);
      sources.push({ role: 'member', userId, identityHash, namespace: `kg_${identityHash.slice(0, 48)}`,
        directory: `data/users/${userId}/knowledge`, displayName: registered?.displayName ?? 'knowledge' });
    }
    if (existsSync(cli)) {
      const skip = (path: string) => /(?:^|\/)[^/]*lease\.sqlite(?:-(?:wal|shm|journal))?$/.test(path) || /\.tmp$/.test(path);
      trees.push({ root: cli, prefix: 'cli', before: inventory(cli, 'cli', skip), skip });
    } else excluded.push('CLI state directory absent');
    const known = new Set([...databaseNames, ...databaseNames.flatMap((name) => ['-wal', '-shm', '-journal'].map((suffix) => name + suffix)),
      'users', 'cli', 'cli-session.json', 'runtime-lease.sqlite', 'runtime-lease.sqlite-journal', 'source-identities.json', 'instance-identity.json', 'restore-quarantine.json', 'backups']);
    for (const name of readdirSync(dataDir)) if (!known.has(name)) excluded.push(`data/${name}`);
    if (existsSync(join(dataDir, 'backups'))) excluded.push('data/backups');
    const databases: DatabaseEntry[] = [];
    for (const name of databaseNames) {
      const source = join(dataDir, name); readOrdinary(source);
      mkdirSync(join(stage, 'data'), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(source, { readOnly: true });
      try { await backup(db, join(stage, 'data', name)); chmodSync(join(stage, 'data', name), 0o600); }
      finally { db.close(); }
      databases.push(databaseInfo(join(stage, 'data', name), `data/${name}`));
    }
    for (const tree of trees) copyInventory(tree.root, stage, tree.before, tree.prefix);
    if (options.envFile) { writePrivate(join(stage, 'config/environment.env'), readOrdinary(canonical(options.envFile))); configuration.push('config/environment.env'); }
    if (options.cliSessionFile) {
      const credential = JSON.parse(readOrdinary(canonical(options.cliSessionFile)).toString('utf8')) as Record<string, unknown>;
      writePrivate(join(stage, 'config/cli-session-metadata.json'), JSON.stringify({ version: credential.version, credentialArchived: false }));
      configuration.push('config/cli-session-metadata.json');
    }
    for (const tree of trees) if (!sameFiles(tree.before, inventory(tree.root, tree.prefix, tree.skip))) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
    const files = inventory(stage);
    const manifest: InstanceManifestV2 = { format: 'living-memory-instance', version: 2, applicationVersion: CURRENT_APPLICATION_VERSION,
      learningSchemaVersion: schemaVersion, createdAt: (options.now?.() ?? new Date()).toISOString(),
      instanceId: readInstanceId(dataDir), files, databases, sources, configuration, excluded, browserState: 'not-included' };
    writePrivate(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
    verifyInstanceBundle(stage);
    if (mainDatabaseIdentities(dataDir) !== mainIdentities) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
    if (learningSchemaVersion(join(dataDir, 'living-memory.sqlite')) !== schemaVersion) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
    await scanner.scan(databasePaths(dataDir));
    await scanner.close(); scanner = null;
    publish(stage, output); stage = null; return manifest;
  } catch (error) { operationFailed = true; throw error; }
  finally {
    try { try { await scanner?.close(); } catch (error) { if (!operationFailed) throw error; } }
    finally { try { if (stage) rmSync(stage, { recursive: true, force: true }); } finally { lock.release(); } }
  }
}

/** Validate every byte and source mapping before a target is created. */
export function verifyInstanceBundle(bundle: string): InstanceManifest {
  ordinaryDirectory(bundle);
  const raw = readOrdinary(join(bundle, 'manifest.json'));
  if (raw.length > 32 * 1024 * 1024) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
  let manifest: InstanceManifest;
  try { manifest = JSON.parse(raw.toString('utf8')); } catch { throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID'); }
  if (!manifest || manifest.format !== 'living-memory-instance'
    || !((manifest.version === 1 && manifest.applicationVersion === LEGACY_APPLICATION_VERSION && !Object.hasOwn(manifest, 'learningSchemaVersion'))
      || (manifest.version === 2 && manifest.applicationVersion === CURRENT_APPLICATION_VERSION && [1, 2, 3].includes(manifest.learningSchemaVersion)))
    || !isValidInstant(manifest.createdAt) || manifest.browserState !== 'not-included' || typeof manifest.instanceId !== 'string'
    || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > MAX_FILES || !Array.isArray(manifest.databases)
    || !Array.isArray(manifest.sources) || !manifest.sources.length || !Array.isArray(manifest.configuration) || !Array.isArray(manifest.excluded)) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
  // Reject every symlink in the tree before dereferencing any manifest path.
  const actual = inventory(bundle).filter((entry) => entry.path !== 'manifest.json');
  const seen = new Set<string>(); let total = 0;
  for (const file of manifest.files) {
    if (!file || !safeRelative(file.path) || file.path === 'manifest.json' || seen.has(file.path) || !Number.isSafeInteger(file.size)
      || file.size < 0 || file.size > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
    seen.add(file.path); total += file.size;
    if (total > MAX_TOTAL_BYTES) throw new InstanceBackupError('INSTANCE_LIMIT_EXCEEDED');
    const content = readOrdinary(join(bundle, file.path));
    if (content.length !== file.size || hash(content) !== file.sha256) throw new InstanceBackupError('INSTANCE_HASH_MISMATCH');
  }
  if (!sameFiles([...manifest.files].sort((a, b) => a.path.localeCompare(b.path)), actual.sort((a, b) => a.path.localeCompare(b.path)))) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
  const directories = new Set<string>(), identities = new Set<string>(), seeds = new Set<string>();
  let owners = 0;
  for (const source of manifest.sources) {
    if (!source || !safeRelative(source.directory) || !/^[a-f0-9]{64}$/.test(source.identityHash) || source.namespace !== `kg_${source.identityHash.slice(0, 48)}`
      || typeof source.displayName !== 'string' || !source.displayName.trim() || source.displayName.length > 256 || /[\u0000-\u001f\u007f]/.test(source.displayName)
      || directories.has(source.directory) || identities.has(source.identityHash.slice(0, 48)) || seeds.has(source.identityHash.slice(0, 24))) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
    if (source.role === 'owner') { owners += 1; if (source.directory !== 'knowledge/owner') throw new InstanceBackupError('INSTANCE_SOURCE_INVALID'); }
    else if (source.role !== 'member' || typeof source.userId !== 'string' || !/^[a-f0-9-]{36}$/.test(source.userId)
      || source.directory !== `data/users/${source.userId}/knowledge`) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
    directories.add(source.directory); identities.add(source.identityHash.slice(0, 48)); seeds.add(source.identityHash.slice(0, 24));
  }
  if (owners !== 1 || manifest.configuration.some((path) => !['config/environment.env', 'config/cli-session-metadata.json'].includes(path) || !seen.has(path))) throw new InstanceBackupError('INSTANCE_MANIFEST_INVALID');
  for (const path of ['data/living-memory.sqlite', 'data/accounts.sqlite']) {
    if (seen.has(path) !== manifest.databases.some((entry) => entry.path === path)) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
  }
  if (seen.has('data/accounts.sqlite')) {
    const accounts = new DatabaseSync(join(bundle, 'data/accounts.sqlite'), { readOnly: true });
    try {
      const ownerId = String(accounts.prepare("SELECT value FROM meta WHERE key='firstOwnerId'").get()?.value ?? '') || null;
      const users = new Set(accounts.prepare('SELECT id FROM accounts').all().map((row) => String(row.id)));
      if ((ownerId !== null && !users.has(ownerId)) || (users.size > 0 && ownerId === null)) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
      if (manifest.sources.find((source) => source.role === 'owner')!.userId !== ownerId) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
      for (const source of manifest.sources) if (source.role === 'member' && (!users.has(source.userId!) || source.userId === ownerId)) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
      for (const userId of users) if (userId !== ownerId && !manifest.sources.some((source) => source.role === 'member' && source.userId === userId)) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
    } finally { accounts.close(); }
  } else if (manifest.sources.some((source) => source.role !== 'owner' || source.userId !== null)) throw new InstanceBackupError('INSTANCE_SOURCE_INVALID');
  validateDatabases(bundle, manifest.databases);
  const actualLearningSchemaVersion = learningSchemaVersion(join(bundle, 'data/living-memory.sqlite'));
  if (actualLearningSchemaVersion !== (manifest.version === 1 ? 1 : manifest.learningSchemaVersion)) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
  return manifest;
}

export async function restoreInstance(options: RestoreInstanceOptions): Promise<RestoreReport> {
  const bundle = canonical(options.bundle), target = canonical(options.target);
  ensureSeparate(target, [bundle]);
  const manifest = verifyInstanceBundle(bundle);
  if (options.preserveLegacyLearningSchema !== undefined && typeof options.preserveLegacyLearningSchema !== 'boolean') throw new InstanceBackupError('INVALID_INSTANCE_ARGUMENT');
  if (options.targetLearningSchemaVersion !== undefined && options.targetLearningSchemaVersion !== 2 && options.targetLearningSchemaVersion !== 3) throw new InstanceBackupError('INVALID_INSTANCE_ARGUMENT');
  if (options.preserveLegacyLearningSchema !== undefined && options.targetLearningSchemaVersion !== undefined) throw new InstanceBackupError('INVALID_INSTANCE_ARGUMENT');
  const sourceSchemaVersion = manifest.version === 1 ? 1 : manifest.learningSchemaVersion;
  if (options.preserveLegacyLearningSchema && sourceSchemaVersion !== 1) throw new InstanceBackupError('INVALID_INSTANCE_ARGUMENT');
  if (sourceSchemaVersion === 3 && options.targetLearningSchemaVersion !== 3) throw new InstanceBackupError('INSTANCE_SCHEMA_TARGET_REQUIRED');
  const targetSchemaVersion = options.preserveLegacyLearningSchema ? 1 : options.targetLearningSchemaVersion ?? 2;
  let stage: string | null = newStage(target);
  let lock: ReturnType<typeof acquireDataDirectoryLock> | null = null;
  try {
    lock = acquireDataDirectoryLock(join(stage, 'data'));
    copyInventory(bundle, stage, manifest.files);
    for (const source of manifest.sources) mkdirSync(join(stage, source.directory), { recursive: true, mode: 0o700 });
    mkdirSync(join(stage, 'cli'), { recursive: true, mode: 0o700 });
    const identities: SourceIdentityRegistry = parseSourceIdentityRegistry({ format: 'living-memory-source-identities', version: 1,
      entries: manifest.sources.map((source) => ({ physicalRoot: join(target, source.directory), identityHash: source.identityHash, displayName: source.displayName })) });
    writePrivate(join(stage, 'data/source-identities.json'), JSON.stringify(identities, null, 2));
    const restoredAt = (options.now?.() ?? new Date()).toISOString(), instanceId = randomUUID();
    const identity: InstanceIdentity = { format: 'living-memory-instance-identity', version: 1, instanceId };
    const quarantine: RestoreQuarantine = { format: 'living-memory-restore-quarantine', version: 1, restoredAt, connectorsBlocked: true };
    writePrivate(join(stage, 'data/instance-identity.json'), JSON.stringify(identity));
    writePrivate(join(stage, 'data/restore-quarantine.json'), JSON.stringify(quarantine));
    const invalidated: Record<string, number> = {};
    const schemaMigrations: string[] = [];
    if (sourceSchemaVersion === 1 && !options.preserveLegacyLearningSchema) {
      const db = new DatabaseSync(join(stage, 'data/living-memory.sqlite'));
      try {
        db.exec('PRAGMA foreign_keys=ON');
        migrateLearningSchemaV1ToV2(db, { recordedAt: restoredAt });
        schemaMigrations.push('learning-schema-v2');
      } catch { throw new InstanceBackupError('INSTANCE_DATABASE_INVALID'); }
      finally { db.close(); }
    }
    if (targetSchemaVersion === 3 && sourceSchemaVersion !== 3) {
      const learningPath = join(stage, 'data/living-memory.sqlite');
      const candidatePath = `${learningPath}.schema3-${randomUUID()}.tmp`;
      let source: DatabaseSync | undefined, destination: DatabaseSync | undefined;
      try {
        source = new DatabaseSync(learningPath, { readOnly: true });
        destination = new DatabaseSync(candidatePath);
        chmodSync(candidatePath, 0o600);
        source.exec('PRAGMA foreign_keys=ON'); destination.exec('PRAGMA foreign_keys=ON');
        copyLearningSchemaV2ToV3(source, destination, { recordedAt: restoredAt });
      } catch { throw new InstanceBackupError('INSTANCE_DATABASE_INVALID'); }
      finally { try { destination?.close(); } finally { source?.close(); } }
      // These are owned staging copies. Never attach old WAL/journal state to the new main file.
      for (const suffix of ['-wal', '-shm', '-journal']) rmSync(learningPath + suffix, { force: true });
      renameSync(candidatePath, learningPath);
      schemaMigrations.push('learning-schema-v3');
    }
    if (manifest.databases.some((entry) => entry.path === 'data/accounts.sqlite')) {
      const db = new DatabaseSync(join(stage, 'data/accounts.sqlite'));
      try {
        db.exec('BEGIN IMMEDIATE');
        const change = (key: string, sql: string, ...parameters: string[]) => { invalidated[key] = Number(db.prepare(sql).run(...parameters).changes); };
        change('sessions', 'DELETE FROM sessions');
        change('pendingBindingCodes', "UPDATE feishu_binding_requests SET status='invalidated' WHERE status='pending'");
        change('activeCards', "UPDATE feishu_card_views SET status='consumed',expires_at=? WHERE status IN ('draft','active')", restoredAt);
        invalidated.activeReviews = 0;
        for (const row of db.prepare("SELECT id,version,state_json FROM feishu_review_sessions WHERE phase<>'finished'").all()) {
          const state: unknown = JSON.parse(String(row.state_json));
          if (!isValidFeishuReviewState(state) || !Number.isSafeInteger(row.version) || Number(row.version) >= Number.MAX_SAFE_INTEGER) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
          state.phase = 'finished';
          if (state.batch) {
            const item = state.batch.items[state.batch.cursor];
            if (item.disposition === 'open') item.disposition = db.prepare("SELECT 1 FROM feishu_review_operations WHERE session_id=? AND status='pending'").get(String(row.id)) ? 'conflict' : 'ended';
          }
          if (!isValidFeishuReviewState(state)) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
          invalidated.activeReviews += Number(db.prepare("UPDATE feishu_review_sessions SET phase='finished',version=version+1,expires_at=?,state_json=? WHERE id=?")
            .run(restoredAt, JSON.stringify(state), String(row.id)).changes);
        }
        change('pendingReviewIntents', "UPDATE feishu_review_operations SET status='conflict',error_code='INSTANCE_RESTORED',settled_at=? WHERE status='pending'", restoredAt);
        change('unknownReadReceipts', "UPDATE feishu_read_receipts SET status='failed-or-unknown' WHERE status='attempted'");
        db.exec('COMMIT');
      } catch (error) { try { db.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
      finally { db.close(); }
    }
    for (const entry of manifest.databases) databaseInfo(join(stage, entry.path), entry.path);
    if (learningSchemaVersion(join(stage, 'data/living-memory.sqlite')) !== targetSchemaVersion) throw new InstanceBackupError('INSTANCE_DATABASE_INVALID');
    const report: RestoreReport = { format: 'living-memory-restore-report', version: 1, restoredAt, instanceId, files: manifest.files.length,
      sources: manifest.sources.length, invalidated, schemaMigrations, connectorsBlocked: true, browserState: 'not-included', startup: {
        dataDir: join(target, 'data'), kgRoot: join(target, 'knowledge/owner'), cliStateDir: join(target, 'cli'),
        envArchive: manifest.configuration.includes('config/environment.env') ? join(target, 'config/environment.env') : null,
      } };
    if (targetSchemaVersion === 3) report.learningSchemaCandidate = { schemaVersion: 3, runtimeReady: false };
    writePrivate(join(stage, 'restore-report.json'), JSON.stringify(report, null, 2));
    lock.release(); lock = null;
    // Re-read the bundle to detect modifications during staging as well.
    verifyInstanceBundle(bundle); publish(stage, target); stage = null; return report;
  } finally { lock?.release(); if (stage) rmSync(stage, { recursive: true, force: true }); }
}

/** Explicit offline acknowledgement; this function never connects or sends. */
export async function activateRestoredConnectors(dataDir: string, confirmed: boolean, options: { procRoot?: string; offlineCheck?: 'native' | 'sudo' } = {}): Promise<void> {
  if (!confirmed) throw new InstanceBackupError('CONNECTOR_CONFIRMATION_REQUIRED');
  const lock = acquireDataDirectoryLock(dataDir); let scanner: OfflineScanner | null = null; let operationFailed = false;
  try {
    const mainIdentities = mainDatabaseIdentities(dataDir);
    scanner = await createOfflineScanner({ mode: options.offlineCheck, dataDir, procRoot: options.procRoot });
    await scanner.scan(databasePaths(dataDir));
    if (learningSchemaVersion(join(dataDir, 'living-memory.sqlite')) === 3) throw new InstanceBackupError('INSTANCE_RUNTIME_UNSUPPORTED');
    if (!isRestoreQuarantined(dataDir)) throw new InstanceBackupError('RESTORE_QUARANTINE_NOT_PRESENT');
    const path = join(dataDir, 'restore-quarantine.json');
    const state = JSON.parse(readOrdinary(path).toString('utf8')) as RestoreQuarantine;
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'connectorsBlocked,format,restoredAt,version'
      || state.format !== 'living-memory-restore-quarantine' || state.version !== 1 || state.connectorsBlocked !== true || !isValidInstant(state.restoredAt)) throw new InstanceBackupError('RESTORE_QUARANTINE_INVALID');
    if (mainDatabaseIdentities(dataDir) !== mainIdentities) throw new InstanceBackupError('INSTANCE_SOURCE_CHANGED');
    await scanner.scan(databasePaths(dataDir));
    await scanner.close(); scanner = null;
    const temporary = `${path}.${randomUUID()}.tmp`;
    writePrivate(temporary, JSON.stringify({ ...state, connectorsBlocked: false })); renameSync(temporary, path);
  } catch (error) { operationFailed = true; throw error; }
  finally {
    try { try { await scanner?.close(); } catch (error) { if (!operationFailed) throw error; } }
    finally { lock.release(); }
  }
}
