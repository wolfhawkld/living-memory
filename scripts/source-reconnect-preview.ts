import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { previewSourceReconnect, SourceReconnectPreviewError } from '../src/integrations/source-reconnect-preview.js';

const HELP = `恢复后知识源重接预览（只读）

node --import tsx scripts/source-reconnect-preview.ts --instance-root <恢复实例目录> --kg-root <拟接入的知识根目录> --url <本机HTTP地址> [--project-root <Living Memory项目>]

只读取恢复元数据、知识源与钩子文件；不打开数据库，不读取设备令牌或环境归档，不发送请求。
输出拟议身份登记、内容差异数量、钩子文件计划与新实例运行路径。
可审阅不等于已接通；钩子运行目录仅已规划，尚未安装或生效。
没有 --apply，不会修改知识源、登记表、钩子、服务、待发队列或飞书隔离状态；实际切换前重新核对。
`;
export function runSourceReconnectPreviewCli(argv: readonly string[]) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return HELP;
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const match = /^--(instance-root|kg-root|url|project-root)(?:=(.*))?$/.exec(argv[index]);
    if (!match || flags.has(match[1])) throw new SourceReconnectPreviewError('INVALID_RECONNECT_ARGUMENT');
    const value = match[2] ?? argv[++index];
    if (!value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) throw new SourceReconnectPreviewError('INVALID_RECONNECT_ARGUMENT');
    flags.set(match[1], value);
  }
  const required = (key: string) => {
    const value = flags.get(key); if (!value?.trim()) throw new SourceReconnectPreviewError('INVALID_RECONNECT_ARGUMENT');
    return value;
  };
  return previewSourceReconnect({ instanceRoot: required('instance-root'), kgRoot: required('kg-root'), serverUrl: required('url'),
    ...(flags.has('project-root') ? { projectRoot: flags.get('project-root') } : {}) });
}
export function sourceReconnectPreviewMain(argv: readonly string[], io: { stdout: (value: string) => void; stderr: (value: string) => void }): number {
  try {
    const result = runSourceReconnectPreviewCli(argv);
    io.stdout(typeof result === 'string' ? result : `${JSON.stringify(result)}\n`);
    return typeof result !== 'string' && result.status === 'blocked' ? 1 : 0;
  } catch (error) {
    const code = error instanceof SourceReconnectPreviewError ? error.code : 'SOURCE_RECONNECT_PREVIEW_FAILED';
    io.stderr(`${JSON.stringify({ error: { code } })}\n`); return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = sourceReconnectPreviewMain(process.argv.slice(2), {
    stdout: value => { process.stdout.write(value); }, stderr: value => { process.stderr.write(value); },
  });
}
