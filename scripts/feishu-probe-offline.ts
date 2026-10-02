import { pathToFileURL } from 'node:url';
import {
  buildOfflineProbeCard,
  evaluateOfflineProbeAction,
  normalizeFeishuCardAction,
  resolveSyntheticBinding,
  type ExpectedOfflineProbe,
  type SyntheticBinding,
} from '../src/integrations/feishu-protocol.js';

const expected: ExpectedOfflineProbe = {
  probeId: 'lm-synthetic-offline-probe',
  appId: 'cli_lm_synthetic',
  tenantKey: 'synthetic-tenant',
  openId: 'ou_synthetic_actor',
  openMessageId: 'om_synthetic_message',
  openChatId: 'oc_synthetic_chat',
};

const binding: SyntheticBinding = {
  appId: expected.appId,
  tenantKey: expected.tenantKey,
  openId: expected.openId,
  accountId: '00000000-0000-4000-8000-000000000001',
  enabled: true,
};

/** Reduced synthetic raw envelope, not an authenticated SDK event. */
function envelope(eventId = 'synthetic-card-action-001') {
  return {
    schema: '2.0',
    header: {
      event_id: eventId,
      event_type: 'card.action.trigger',
      app_id: expected.appId,
      tenant_key: expected.tenantKey,
    },
    event: {
      operator: { open_id: expected.openId, tenant_key: expected.tenantKey },
      context: {
        open_message_id: expected.openMessageId,
        open_chat_id: expected.openChatId,
      },
      action: {
        tag: 'button',
        value: { kind: 'lm-feishu-offline-probe', probeId: expected.probeId },
      },
    },
  };
}

interface OfflineReceipt {
  status: 'offline-protocol-confirmed';
  receiptId: string;
  toast: { type: 'info'; content: string };
}

type ProbeResult =
  | { ok: true; duplicate: boolean; receipt: OfflineReceipt }
  | { ok: false; reason: string };

export interface OfflineProbeReport {
  mode: 'offline';
  platformVerified: false;
  knowledgeAccessed: false;
  learningWrites: 0;
  transport: 'none';
  networkPolicy: string;
  authentication: 'not-performed';
  card: ReturnType<typeof buildOfflineProbeCard>;
  cases: { name: string; passed: boolean }[];
  passed: number;
  total: number;
  duplicateReceiptReused: boolean;
}

/** Runs synthetic protocol examples only; no SDK, service, credentials or network path. */
export function runOfflineProbe(): OfflineProbeReport {
  const receipts = new Map<string, OfflineReceipt>();
  const cases: OfflineProbeReport['cases'] = [];

  function check(name: string, passed: boolean): void {
    cases.push({ name, passed });
  }

  function accept(raw: unknown, fixtures: readonly SyntheticBinding[] = [binding]): ProbeResult {
    const parsed = normalizeFeishuCardAction(raw, expected.appId);
    if (!parsed.ok) return parsed;
    const identity = resolveSyntheticBinding(parsed.value, fixtures);
    if (!identity.ok) return identity;
    const confirmed = evaluateOfflineProbeAction(parsed.value, expected);
    if (!confirmed.ok) return confirmed;
    const key = JSON.stringify([
      parsed.value.appId, parsed.value.tenantKey, parsed.value.openId, parsed.value.eventId,
    ]);
    const previous = receipts.get(key);
    if (previous) return { ok: true, duplicate: true, receipt: previous };
    const receipt: OfflineReceipt = {
      ...confirmed.value,
      receiptId: `synthetic-protocol-receipt-${receipts.size + 1}`,
    };
    receipts.set(key, receipt);
    return { ok: true, duplicate: false, receipt };
  }

  const first = accept(envelope());
  const repeated = accept(envelope());
  const reused = first.ok && repeated.ok && repeated.duplicate && first.receipt === repeated.receipt;
  check('synthetic-envelope-accepted', first.ok && !first.duplicate);
  check('duplicate-offline-receipt-reused', reused);

  const wrongApp = envelope();
  wrongApp.header.app_id = 'cli_other_synthetic';
  check('different-app-rejected', !accept(wrongApp).ok);

  const wrongTenant = envelope();
  wrongTenant.header.tenant_key = 'other-synthetic-tenant';
  wrongTenant.event.operator.tenant_key = 'other-synthetic-tenant';
  check('different-tenant-rejected', !accept(wrongTenant).ok);

  const wrongActor = envelope();
  wrongActor.event.operator.open_id = 'ou_other_synthetic_actor';
  check('unbound-actor-rejected', !accept(wrongActor).ok);
  check('disabled-binding-rejected', !accept(envelope(), [{ ...binding, enabled: false }]).ok);

  const wrongChat = envelope();
  wrongChat.event.context.open_chat_id = 'oc_other_synthetic_chat';
  check('different-chat-rejected', !accept(wrongChat).ok);

  const wrongMessage = envelope();
  wrongMessage.event.context.open_message_id = 'om_other_synthetic_message';
  check('different-message-rejected', !accept(wrongMessage).ok);

  const wrongProbe = envelope();
  wrongProbe.event.action.value.probeId = 'other-synthetic-probe';
  check('different-probe-rejected', !accept(wrongProbe).ok);

  const forged = envelope();
  Object.assign(forged.event.action.value, { accountId: 'forged-account', sourceId: 'forged-source' });
  check('payload-account-claims-rejected', !accept(forged).ok);
  check('malformed-envelope-rejected', !accept({}).ok);

  return {
    mode: 'offline',
    platformVerified: false,
    knowledgeAccessed: false,
    learningWrites: 0,
    transport: 'none',
    networkPolicy: '本命令无网络路径；仅运行固定合成协议用例。',
    authentication: 'not-performed',
    card: buildOfflineProbeCard(expected.probeId),
    cases,
    passed: cases.filter((item) => item.passed).length,
    total: cases.length,
    duplicateReceiptReused: reused,
  };
}

export function offlineProbeCommand(args: readonly string[], write: (text: string) => void): number {
  if (args.length === 1 && args[0] === '--help') {
    write('用法：npm run feishu:probe:offline\n仅合成离线协议验证，无发送、凭证或知识源参数。');
    return 0;
  }
  if (args.length !== 0) {
    write('离线探针不接受发送、联网、凭证或知识源参数；使用 --help 查看用法。');
    return 2;
  }
  const report = runOfflineProbe();
  write(JSON.stringify(report, null, 2));
  return report.passed === report.total ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = offlineProbeCommand(process.argv.slice(2), (text) => process.stdout.write(`${text}\n`));
  } catch {
    process.stderr.write('合成离线协议探针运行失败，请运行对应测试核对。\n');
    process.exitCode = 1;
  }
}
