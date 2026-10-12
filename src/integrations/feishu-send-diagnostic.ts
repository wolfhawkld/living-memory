export type FeishuSendDiagnosticStage = 'prepare-unavailable' | 'authorization-rejected' | 'local-budget'
  | 'platform-rejected' | 'send-failed' | 'response-invalid' | 'chat-mismatch' | 'send-unavailable' | 'request-invalid';
export interface FeishuSendDiagnostic {
  readonly stage: FeishuSendDiagnosticStage;
  readonly code?: number;
  readonly httpStatus?: number;
}
const STAGES = new Set<FeishuSendDiagnosticStage>(['prepare-unavailable', 'authorization-rejected', 'local-budget',
  'platform-rejected', 'send-failed', 'response-invalid', 'chat-mismatch', 'send-unavailable', 'request-invalid']);
function code(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function status(value: unknown): value is number { return typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599; }

/** Observers receive an immutable numeric allowlist, never SDK response/error bodies. */
export function notifyFeishuSendDiagnostic(observer: ((diagnostic: FeishuSendDiagnostic) => void) | undefined, value: unknown): void {
  try {
    if (!observer || !value || typeof value !== 'object') return;
    const input = value as Record<string, unknown>;
    const stage = input.stage;
    if (typeof stage !== 'string' || !STAGES.has(stage as FeishuSendDiagnosticStage)) return;
    const numericCode = input.code; const httpStatus = input.httpStatus;
    observer(Object.freeze({ stage: stage as FeishuSendDiagnosticStage,
      ...(code(numericCode) ? { code: numericCode } : {}), ...(status(httpStatus) ? { httpStatus } : {}) }));
  } catch { /* Diagnostic collection must not change delivery behavior. */ }
}

/** Only inspect the SDK HTTP error's numeric response fields. */
export function feishuSendFailureDiagnostic(error: unknown): FeishuSendDiagnostic {
  try {
    const response = (error as { response?: { data?: { code?: unknown }; status?: unknown } } | null)?.response;
    const numericCode = response?.data?.code; const httpStatus = response?.status;
    return Object.freeze({ stage: code(numericCode) && numericCode !== 0 ? 'platform-rejected' : 'send-failed',
      ...(code(numericCode) ? { code: numericCode } : {}), ...(status(httpStatus) ? { httpStatus } : {}) });
  } catch { return Object.freeze({ stage: 'send-failed' }); }
}
