import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKnowledgeGraph } from '../server/kg.js';
import { readInstanceId } from '../server/instance-state.js';
import { parseSourceIdentityRegistry, readSourceIdentityRegistry, sourceIdentityHash,
  type SourceIdentityRegistry } from '../server/source-identities.js';
import { isValidInstant } from '../core/time-model.js';
import { planHookInstall } from './install-kg-hook.js';

export type SourceReconnectPreviewErrorCode = 'INVALID_RECONNECT_ARGUMENT' | 'RESTORE_CONTEXT_INVALID'
  | 'SOURCE_REGISTRY_INVALID' | 'SOURCE_IDENTITY_CONFLICT' | 'KNOWLEDGE_SOURCE_INVALID';
export class SourceReconnectPreviewError extends Error {
  constructor(readonly code: SourceReconnectPreviewErrorCode) { super(code); this.name = 'SourceReconnectPreviewError'; }
}
export interface SourceReconnectPreviewOptions {
  instanceRoot: string;
  kgRoot: string;
  serverUrl: string;
  projectRoot?: string;
}
export interface SourceReconnectPreview {
  format: 'living-memory-source-reconnect-preview';
  version: 1;
  status: 'reviewable' | 'blocked';
  source: {
    namespace: string; identityHash: string; displayName: string;
    fromRoot: string; toRoot: string; fromFingerprint: string; toFingerprint: string;
  };
  proposedRegistry: SourceIdentityRegistry;
  knowledge: {
    before: { concepts: number; links: number }; after: { concepts: number; links: number };
    commonConcepts: number; addedConcepts: number; missingConcepts: number; changedVersions: number;
    stableIdsPreserved: boolean;
    diagnostics: { before: number; after: number };
  };
  hook: {
    status: 'planned' | 'conflict'; files: Array<{ path: string; localOnly: boolean }>;
    code?: 'HOOK_PLAN_CONFLICT'; runtimeDirectoriesSupported: true;
    runtimeConfiguration: 'planned' | 'unavailable';
  };
  runtime: {
    LM_DATA_DIR: string; LM_CLI_STATE_DIR: string; LM_CLI_SESSION_FILE: string;
    LM_SERVER_URL: string; LM_KG_ROOT: string; LM_FEISHU_ENABLED: '0';
  };
  limitations: string[];
}

function fail(code: SourceReconnectPreviewErrorCode): never { throw new SourceReconnectPreviewError(code); }
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function contains(parent: string, child: string): boolean {
  const suffix = relative(parent, child);
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('../') && !suffix.startsWith('..\\'));
}
function overlaps(first: string, second: string): boolean { return contains(first, second) || contains(second, first); }
function directory(path: string): string {
  const canonical = realpathSync(resolve(path));
  if (!lstatSync(canonical).isDirectory()) throw new Error();
  return canonical;
}
function privateJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024
    || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error();
  return JSON.parse(readFileSync(path, 'utf8'));
}
function readRestoreContext(instanceRoot: string) {
  try {
    const root = directory(instanceRoot), dataDir = join(root, 'data'), kgRoot = join(root, 'knowledge/owner');
    if (directory(dataDir) !== dataDir || directory(kgRoot) !== kgRoot) throw new Error();
    const report = privateJson(join(root, 'restore-report.json'));
    if (!object(report) || report.format !== 'living-memory-restore-report' || report.version !== 1
      || !count(report.files) || !count(report.sources) || report.sources < 1
      || typeof report.restoredAt !== 'string' || !isValidInstant(report.restoredAt)
      || report.connectorsBlocked !== true || report.browserState !== 'not-included'
      || !object(report.invalidated) || !Object.values(report.invalidated).every(count)
      || !Array.isArray(report.schemaMigrations) || report.schemaMigrations.length > 1
      || report.schemaMigrations.some(value => value !== 'learning-schema-v2')
      || !object(report.startup) || report.startup.dataDir !== dataDir || report.startup.kgRoot !== kgRoot
      || report.startup.cliStateDir !== join(root, 'cli')
      || ![null, join(root, 'config/environment.env')].includes(report.startup.envArchive as string | null)
      || readInstanceId(dataDir) === 'legacy' || readInstanceId(dataDir) !== report.instanceId) throw new Error();
    const quarantine = privateJson(join(dataDir, 'restore-quarantine.json'));
    if (!object(quarantine) || Object.keys(quarantine).sort().join(',') !== 'connectorsBlocked,format,restoredAt,version'
      || quarantine.format !== 'living-memory-restore-quarantine' || quarantine.version !== 1
      || quarantine.restoredAt !== report.restoredAt || quarantine.connectorsBlocked !== true) throw new Error();
    return { root, dataDir, kgRoot, cliStateDir: join(root, 'cli'), sources: report.sources };
  } catch { return fail('RESTORE_CONTEXT_INVALID'); }
}
function normalizedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { return fail('INVALID_RECONNECT_ARGUMENT'); }
}

/** Read-only snapshot. Never opens SQLite, reads credentials, connects, or applies the proposed changes. */
export function previewSourceReconnect(options: SourceReconnectPreviewOptions): SourceReconnectPreview {
  if (!options || !validPath(options.instanceRoot) || !validPath(options.kgRoot) || !validPath(options.serverUrl)
    || (options.projectRoot !== undefined && !validPath(options.projectRoot))) fail('INVALID_RECONNECT_ARGUMENT');
  const serverUrl = normalizedUrl(options.serverUrl);
  const context = readRestoreContext(options.instanceRoot);
  let registry: SourceIdentityRegistry;
  try {
    const loaded = readSourceIdentityRegistry(context.dataDir);
    if (!loaded || loaded.entries.length !== context.sources) throw new Error();
    registry = loaded;
  } catch { return fail('SOURCE_REGISTRY_INVALID'); }
  const owner = registry.entries.find(entry => entry.physicalRoot === context.kgRoot);
  if (!owner?.displayName) fail('SOURCE_REGISTRY_INVALID');
  let target: string;
  try { target = directory(options.kgRoot); } catch { return fail('KNOWLEDGE_SOURCE_INVALID'); }
  if (overlaps(target, context.dataDir)
    || registry.entries.some(entry => entry !== owner && overlaps(target, entry.physicalRoot))) fail('SOURCE_IDENTITY_CONFLICT');
  let proposedRegistry: SourceIdentityRegistry;
  try {
    proposedRegistry = parseSourceIdentityRegistry({ ...registry,
      entries: registry.entries.map(entry => entry === owner ? { ...entry, physicalRoot: target } : { ...entry }) });
  } catch { return fail('SOURCE_IDENTITY_CONFLICT'); }
  let before: ReturnType<typeof loadKnowledgeGraph>, after: ReturnType<typeof loadKnowledgeGraph>;
  try {
    const identity = { identityHash: owner.identityHash, displayName: owner.displayName };
    before = loadKnowledgeGraph({ root: context.kgRoot, ...identity });
    after = loadKnowledgeGraph({ root: target, ...identity });
  } catch { return fail('KNOWLEDGE_SOURCE_INVALID'); }
  const beforePaths = new Map(before.index.concepts.map(concept => [concept.source.path, concept]));
  const afterPaths = new Map(after.index.concepts.map(concept => [concept.source.path, concept]));
  let commonConcepts = 0, changedVersions = 0, stableIdsPreserved = before.namespace === after.namespace;
  for (const [path, concept] of beforePaths) {
    const current = afterPaths.get(path); if (!current) continue;
    commonConcepts++;
    if (current.source.revision !== concept.source.revision) changedVersions++;
    if (current.id !== concept.id) stableIdsPreserved = false;
  }
  let hook: SourceReconnectPreview['hook'];
  try {
    const projectRoot = options.projectRoot ?? fileURLToPath(new URL('../../', import.meta.url));
    const plan = planHookInstall(target, serverUrl, projectRoot, { dataDir: context.dataDir, cliStateDir: context.cliStateDir });
    hook = { status: 'planned', files: plan.files.map(file => ({ path: file.relativePath, localOnly: file.private })),
      runtimeDirectoriesSupported: true, runtimeConfiguration: 'planned' };
  } catch { hook = { status: 'conflict', code: 'HOOK_PLAN_CONFLICT', files: [],
    runtimeDirectoriesSupported: true, runtimeConfiguration: 'unavailable' }; }
  return {
    format: 'living-memory-source-reconnect-preview', version: 1, status: hook.status === 'conflict' ? 'blocked' : 'reviewable',
    source: { namespace: before.namespace, identityHash: owner.identityHash, displayName: owner.displayName,
      fromRoot: context.kgRoot, toRoot: target, fromFingerprint: sourceIdentityHash(context.kgRoot), toFingerprint: sourceIdentityHash(target) },
    proposedRegistry,
    knowledge: { before: { concepts: before.index.concepts.length, links: before.index.links.length },
      after: { concepts: after.index.concepts.length, links: after.index.links.length }, commonConcepts,
      addedConcepts: afterPaths.size - commonConcepts, missingConcepts: beforePaths.size - commonConcepts, changedVersions, stableIdsPreserved,
      diagnostics: { before: before.index.source.diagnostics.length, after: after.index.source.diagnostics.length } },
    hook,
    runtime: { LM_DATA_DIR: context.dataDir, LM_CLI_STATE_DIR: context.cliStateDir,
      LM_CLI_SESSION_FILE: join(context.dataDir, 'cli-session.json'), LM_SERVER_URL: serverUrl, LM_KG_ROOT: target, LM_FEISHU_ENABLED: '0' },
    limitations: ['PREVIEW_ONLY_RERUN_BEFORE_APPLY', 'SAME_PATH_RAW_IDS_ONLY', 'BINDINGS_AND_HISTORY_NOT_INSPECTED',
      'CONTENT_DIFFERENCES_REQUIRE_REVIEW', 'HOOK_RUNTIME_CONFIGURATION_NOT_APPLIED',
      'SERVICE_AND_HOOK_NOT_RECONFIGURED', 'CONNECTORS_REMAIN_QUARANTINED', 'OLD_QUEUES_MUST_NOT_BE_REPLAYED'],
  };
}
