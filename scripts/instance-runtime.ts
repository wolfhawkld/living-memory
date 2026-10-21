import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkInstanceRuntime, InstanceRuntimeError, prepareInstanceRuntime } from '../src/server/instance-runtime.js';

interface RuntimeIO { stdout: (value: string) => void; stderr: (value: string) => void }
const help = `Living Memory existing-instance runtime (foreground)

  npm run instance -- check --profile /private/runtime.local.json
  npm run instance -- start --profile /private/runtime.local.json [--feishu]

check validates paths and identities only; databases, ports and credentials are not checked.
start uses accounts mode, discards inherited LM_* settings, and defaults Feishu off.
--feishu explicitly reads the profile's private credential file; restore quarantine still applies.
Stop the foreground server with Ctrl+C (SIGINT) or SIGTERM. No daemon is installed.
`;

export async function instanceRuntimeMain(argv: string[], io: RuntimeIO): Promise<number> {
  try {
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) { io.stdout(help); return 0; }
    const command = argv[0];
    if (command !== 'check' && command !== 'start') throw new InstanceRuntimeError('INVALID_RUNTIME_ARGUMENT');
    let profile: string | undefined, feishu = false;
    for (let index = 1; index < argv.length; index++) {
      const flag = argv[index];
      if (flag === '--profile' && profile === undefined && argv[index + 1] && !argv[index + 1].startsWith('--')) profile = argv[++index];
      else if (flag === '--feishu' && command === 'start' && !feishu) feishu = true;
      else throw new InstanceRuntimeError('INVALID_RUNTIME_ARGUMENT');
    }
    if (!profile) throw new InstanceRuntimeError('INVALID_RUNTIME_ARGUMENT');
    if (command === 'check') { io.stdout(JSON.stringify(checkInstanceRuntime(profile)) + '\n'); return 0; }
    const prepared = prepareInstanceRuntime(profile, { feishu });
    for (const key of Object.keys(process.env)) if (key.startsWith('LM_')) delete process.env[key];
    Object.assign(process.env, prepared.environment);
    process.chdir(fileURLToPath(new URL('..', import.meta.url)));
    // Import only after validation and environment replacement. The existing server owns leases and signals.
    await import('../src/server/index.js');
    return 0;
  } catch (error) {
    const code = error instanceof InstanceRuntimeError ? error.code
      : error && typeof error === 'object' && 'code' in error && ['DATA_DIRECTORY_BUSY', 'DATA_DIRECTORY_LOCK_UNKNOWN'].includes(String(error.code))
        ? String(error.code) : 'RUNTIME_START_FAILED';
    io.stderr(JSON.stringify({ error: { code } }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await instanceRuntimeMain(process.argv.slice(2), {
    stdout: value => { process.stdout.write(value); }, stderr: value => { process.stderr.write(value); },
  });
}
