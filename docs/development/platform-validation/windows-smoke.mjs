import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const HTTP_MS = 5_000, START_MS = 30_000, CLI_MS = 15_000;
const EVENT_ID = 'windows-native-smoke-review-001';
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
class CheckError extends Error { constructor(stage, message) { super(message); this.stage = stage; } }
function check(value, stage, message) { if (!value) throw new CheckError(stage, message); }
function safeMessage(error, repo, run) {
  return String(error?.message ?? error).replaceAll(repo, '<repo>').replaceAll(run, '<run>')
    .replace(/[\r\n]+/g, ' ').slice(0, 240);
}
function writeSummary(run, result) { writeFileSync(join(run, 'smoke-result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8'); }
async function freePort() {
  const listener = createServer();
  await new Promise((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveListen); });
  const address = listener.address(), port = typeof address === 'object' && address ? address.port : 0;
  await new Promise((resolveClose, reject) => listener.close(error => error ? reject(error) : resolveClose()));
  check(port > 0, 'prepare', 'failed to obtain a loopback port');
  return port;
}
async function httpRequest(base, path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), HTTP_MS);
  try {
    const response = await fetch(`${base}${path}`, { method: options.method ?? 'GET', headers: options.headers ?? {},
      body: options.body, redirect: 'error', signal: controller.signal });
    const text = await response.text();
    check(text.length <= 16 * 1024 * 1024, 'http', `response too large: ${path}`);
    let json; try { json = text ? JSON.parse(text) : undefined; } catch { /* static response */ }
    return { status: response.status, text, json };
  } catch (error) {
    if (error instanceof CheckError) throw error;
    throw new CheckError('http', `request failed: ${options.method ?? 'GET'} ${path}`);
  } finally { clearTimeout(timer); }
}
async function waitReady(base, child) {
  const until = Date.now() + START_MS;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new CheckError('startup', `server exited: ${child.exitCode}`);
    try { const response = await httpRequest(base, '/api/auth/status'); if (response.status === 200) return response.json; }
    catch { /* keep polling */ }
    await sleep(250);
  }
  throw new CheckError('startup', 'server did not answer within 30 seconds');
}
function waitChild(child, timeoutMs = 5_000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolveWait => { const timer = setTimeout(resolveWait, timeoutMs);
    child.once('close', () => { clearTimeout(timer); resolveWait(); }); });
}
async function stopServer(server) {
  if (!server) return;
  const { child } = server;
  if (child.exitCode === null && Number.isInteger(child.pid)) {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    await waitChild(child);
    if (child.exitCode === null) { spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); await waitChild(child, 1_000); }
  }
}
function startServer(repo, env, logs, label) {
  const stdoutPath = join(logs, `server-${label}.stdout.log`), stderrPath = join(logs, `server-${label}.stderr.log`);
  const stdout = openSync(stdoutPath, 'a'), stderr = openSync(stderrPath, 'a');
  let child;
  try {
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm start'], {
      cwd: repo, env, windowsHide: true, stdio: ['ignore', stdout, stderr],
    });
  } finally { closeSync(stdout); closeSync(stderr); }
  child.on('error', () => {});
  return { child };
}
async function runCli(repo, env, args) {
  return new Promise((resolveCli, rejectCli) => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', tooLarge = false, settled = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { if (stdout.length <= 1_048_576) stdout += chunk.toString(); else tooLarge = true; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(async () => {
      if (child.exitCode === null) child.kill(); await waitChild(child, 1_000);
      if (child.exitCode === null && Number.isInteger(child.pid)) spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      await waitChild(child, 1_000); finish(rejectCli, new CheckError('cli', 'CLI exceeded 15 seconds'));
    }, CLI_MS);
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    child.once('error', () => finish(rejectCli, new CheckError('cli', 'CLI process failed to start')));
    child.once('close', code => {
      if (tooLarge) return finish(rejectCli, new CheckError('cli', 'CLI output exceeded limit'));
      if (code !== 0) return finish(rejectCli, new CheckError('cli', `CLI exited: ${code}`));
      try { finish(resolveCli, JSON.parse(stdout.trim())); } catch { finish(rejectCli, new CheckError('cli', 'CLI did not return JSON')); }
    });
  });
}
function authHeaders(device) { return { Authorization: `Bearer ${device.sessionToken}` }; }
function readDevice(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  check(typeof value.sessionToken === 'string' && value.sessionToken.length >= 32, 'auth', 'owner device session missing');
  return value;
}
function countStatus(snapshot, status) { return Object.values(snapshot.states ?? {}).filter(state => state.status === status).length; }

async function main() {
  const repo = resolve(process.argv[2] ?? ''), run = resolve(process.argv[3] ?? '');
  check(process.argv.length === 4 && repo !== run, 'prepare', 'usage: node lm-windows-native-smoke.mjs <repoRoot> <runRoot>');
  check(existsSync(join(repo, 'package.json')), 'prepare', 'repoRoot is not a checkout');
  const fixture = join(repo, 'fixtures', 'demo-kg'); check(existsSync(fixture), 'prepare', 'public fixture is missing');
  const data = join(run, 'data'), cli = join(run, 'cli'), logs = join(run, 'logs');
  mkdirSync(data, { recursive: true }); mkdirSync(cli, { recursive: true }); mkdirSync(logs, { recursive: true });
  check(!existsSync(join(data, 'accounts.sqlite')), 'prepare', 'runRoot data already has an account database');
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('LM_')) delete env[key];
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${dirname(process.execPath)}${delimiter}${env[pathKey] ?? ''}`;
  env.LM_DATA_DIR = data; env.LM_CLI_STATE_DIR = cli; env.LM_CLI_SESSION_FILE = join(data, 'cli-session.json');
  env.LM_KG_ROOT = fixture; env.LM_AUTH_MODE = 'accounts'; env.LM_PORT = String(await freePort());
  const base = `http://127.0.0.1:${env.LM_PORT}`, devicePath = env.LM_CLI_SESSION_FILE;
  const result = { status: 'failed', platform: process.platform, node: process.version, checks: {} };
  let server; let stage = 'prepare';
  try {
    stage = 'startup'; server = startServer(repo, env, logs, 'first');
    const initialAuth = await waitReady(base, server.child);
    check(initialAuth.enabled === true && initialAuth.needsSetup === true, stage, 'fresh auth status was not setup-required'); result.checks.startup = true;
    stage = 'static'; const home = await httpRequest(base, '/');
    check(home.status === 200 && /<html|<!doctype/i.test(home.text), stage, 'homepage was not served');
    const assetPath = home.text.match(/(?:src|href)=["'](\/assets\/[^"']+)["']/i)?.[1]; check(assetPath, stage, 'homepage lacked a dist asset');
    const asset = await httpRequest(base, assetPath); check(asset.status === 200 && asset.text.length > 0, stage, 'dist asset was not served');
    result.checks.static = { home: home.status, asset: asset.status };
    stage = 'setup'; const username = `wincheck${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const password = `Synthetic-Windows-${randomUUID()}-x`;
    const setup = await httpRequest(base, '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    check(setup.status === 201 && setup.json?.user?.role === 'admin', stage, 'synthetic admin setup failed');
    const device = readDevice(devicePath), headers = authHeaders(device), session = await httpRequest(base, '/api/session', { headers });
    check(session.status === 200 && typeof session.json?.sourceId === 'string', stage, 'owner session missing sourceId');
    const anon = await httpRequest(base, '/api/snapshot?scope=all'); check(anon.status === 401, stage, 'anonymous snapshot was not rejected');
    result.checks.auth = { setup: setup.status, role: 'admin', anonymousSnapshot: anon.status };
    stage = 'initial snapshot'; const initial = await httpRequest(base, '/api/snapshot?scope=all', { headers });
    const initialExport = await httpRequest(base, '/api/export', { headers });
    check(initial.status === 200 && initial.json?.concepts?.length === 16 && initial.json?.links?.length === 32, stage, 'default graph is not 16 concepts / 32 links');
    check(countStatus(initial.json, 'unknown') === 16 && initial.json.observationsCount === 0, stage, 'initial states are not all unknown');
    check(initialExport.status === 200 && initialExport.json?.anchors?.length === 0, stage, 'initial export already has anchors');
    const matrix = initial.json.concepts.find(concept => concept.title === '矩阵'); check(matrix, stage, 'Matrix fixture concept is missing');
    result.checks.initial = { sourceId: session.json.sourceId, concepts: 16, links: 32, unknown: 16, observations: 0 };
    const common = ['--url', base, '--source-root', fixture, '--state-dir', cli];
    stage = 'cli query'; const query = await runCli(repo, env, ['query', 'Vector', ...common]);
    check(query.scope?.loadedConcepts === 16 && query.scope?.sourceConcepts === 16 && query.hits?.some(hit => hit.title === '向量'), stage, 'CLI Vector query missed concepts');
    result.checks.cliQuery = { loadedConcepts: query.scope.loadedConcepts, sourceConcepts: query.scope.sourceConcepts, hit: '向量' };
    stage = 'review'; const review = await runCli(repo, env, ['review', 'Matrix', '--confirm', '--event-id', EVENT_ID, ...common]);
    check(review.response?.status === 'accepted' && review.receipt?.status === 'succeeded' && review.eventId === EVENT_ID, stage, 'CLI review was not accepted');
    const afterReview = await httpRequest(base, '/api/snapshot?scope=all', { headers }), afterExport = await httpRequest(base, '/api/export', { headers });
    const anchor = afterReview.json.states?.[matrix.id]?.anchor;
    check(anchor?.eventId === EVENT_ID && afterExport.json?.anchors?.length === 1 && afterExport.json?.observations?.length === 0, stage, 'review did not create one anchor');
    result.checks.review = { status: review.response.status, receipt: review.receipt.status, eventId: EVENT_ID, occurredAt: anchor.occurredAt };
    stage = 'restart'; await stopServer(server); server = null; server = startServer(repo, env, logs, 'restart');
    const restartedAuth = await waitReady(base, server.child); check(restartedAuth.enabled === true && restartedAuth.needsSetup === false, stage, 'restart lost account setup');
    const login = await httpRequest(base, '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
    check(login.status === 200 && login.json?.user?.role === 'admin', stage, 'admin relogin failed');
    const device2 = readDevice(devicePath), headers2 = authHeaders(device2), session2 = await httpRequest(base, '/api/session', { headers: headers2 });
    const snapshot2 = await httpRequest(base, '/api/snapshot?scope=all', { headers: headers2 }), export2 = await httpRequest(base, '/api/export', { headers: headers2 });
    const anchor2 = snapshot2.json.states?.[matrix.id]?.anchor;
    check(session2.json?.sourceId === session.json.sourceId && snapshot2.json?.concepts?.length === 16 && snapshot2.json?.links?.length === 32, stage, 'source or counts changed after restart');
    check(anchor2?.eventId === EVENT_ID && anchor2.occurredAt === anchor.occurredAt && export2.json?.anchors?.length === 1 && export2.json?.observations?.length === 0, stage, 'anchor was not retained after restart');
    const retry = await runCli(repo, env, ['retry', EVENT_ID, ...common]), finalExport = await httpRequest(base, '/api/export', { headers: headers2 });
    check(retry.response?.status === 'duplicate' && retry.receipt?.status === 'succeeded', stage, 'CLI retry was not duplicate');
    check(finalExport.json?.anchors?.length === 1 && finalExport.json?.observations?.length === 0, stage, 'retry created new learning data');
    result.checks.restart = { relogin: true, sourceIdSame: true, concepts: 16, links: 32, anchorEventId: anchor2.eventId, occurredAt: anchor2.occurredAt, observations: 0, retry: 'duplicate' };
    result.status = 'passed'; result.stage = 'complete';
  } catch (error) { result.stage = error?.stage ?? stage; result.error = safeMessage(error, repo, run); }
  finally { await stopServer(server); writeSummary(run, result); }
  if (result.status !== 'passed') process.exitCode = 1;
}

if (process.platform !== 'win32') process.exitCode = 2;
else main().catch(() => { process.exitCode = 1; });
