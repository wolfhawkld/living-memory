import type { LearningProtocolVersion } from '../shared/learning-protocol';

export interface LocalSession {
  writeToken: string;
  sourceId: string;
  instanceId?: string;
  learningProtocolVersion?: LearningProtocolVersion;
}

export interface SessionRecoveryOptions {
  getSession: () => Promise<LocalSession>;
  isExpired: (error: unknown) => boolean;
  onRecovered?: (session: LocalSession, original: LocalSession) => void;
  onInstanceMismatch?: (actual: LocalSession, original: LocalSession) => void;
  instanceMismatchError?: () => Error;
  onSourceMismatch?: (actualSourceId: string) => void;
  sourceMismatchError?: () => Error;
}

interface CodedError extends Error {
  code?: string;
}

export function normalizeInstanceId(value?: string): string {
  if (value === undefined) return 'legacy';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    throw Object.assign(new Error('本地服务实例标识无效。'), { code: 'SESSION_INVALID' });
  }
  return value;
}

function assertSession(session: LocalSession): LocalSession {
  if (
    !session ||
    typeof session.writeToken !== 'string' ||
    session.writeToken.trim().length === 0 ||
    typeof session.sourceId !== 'string' ||
    session.sourceId.trim().length === 0
  ) {
    const error = new Error('本地服务会话不完整，缺少 writeToken 或 sourceId。') as CodedError;
    error.code = 'SESSION_INVALID';
    throw error;
  }
  normalizeInstanceId(session.instanceId);
  return Object.freeze({ ...session });
}

function sourceMismatchError(options: SessionRecoveryOptions): Error {
  const error = options.sourceMismatchError?.() ?? new Error('服务正在使用另一个知识源，请重新连接后确认操作。');
  (error as CodedError).code = 'SOURCE_MISMATCH';
  return error;
}

/**
 * Retry one write after the local server renews its session token. Recovery is
 * deliberately bounded: only the first expired-token failure is retried, and
 * all callers share one session request while it is in flight.
 */
export function createSessionRecovery(options: SessionRecoveryOptions) {
  let recoveryInFlight: Promise<LocalSession> | null = null;

  const recover = (): Promise<LocalSession> => {
    if (!recoveryInFlight) {
      recoveryInFlight = Promise.resolve()
        .then(options.getSession)
        .then(assertSession)
        .finally(() => {
          recoveryInFlight = null;
        });
    }
    return recoveryInFlight;
  };

  return {
    async run<T>(session: LocalSession, send: (credentials: LocalSession) => Promise<T>): Promise<T> {
      const original = assertSession(session);
      try {
        return await send(original);
      } catch (error) {
        if (!options.isExpired(error)) throw error;

        const refreshed = await recover();
        if (refreshed.sourceId !== original.sourceId) {
          options.onSourceMismatch?.(refreshed.sourceId);
          throw sourceMismatchError(options);
        }
        if (normalizeInstanceId(refreshed.instanceId) !== normalizeInstanceId(original.instanceId)) {
          options.onInstanceMismatch?.(refreshed, original);
          throw Object.assign(options.instanceMismatchError?.() ?? new Error('知识空间实例已变化，请重新加载。'), { code: 'INSTANCE_MISMATCH' });
        }
        options.onRecovered?.(refreshed, original);
        return send(refreshed);
      }
    },
  };
}
