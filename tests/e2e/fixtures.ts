import { expect, test as base, type APIRequestContext } from '@playwright/test';
import type { AccountStatus, AccountUser } from '../../src/shared/accounts';

/** Synthetic credentials used only by the isolated E2E server data directory. */
export const TEST_OWNER_USERNAME = 'e2e-owner';
export const TEST_OWNER_PASSWORD = 'e2e-owner-password-2026';

export interface TestOwnerSession {
  userId: string;
  sourceId: string;
}

interface SessionResponse {
  writeToken?: string;
  sourceId?: string;
  user?: AccountUser;
}

function responseFailure(endpoint: string, response: { status(): number }): Error {
  return new Error(`E2E authentication request ${endpoint} failed with HTTP ${response.status()}.`);
}

async function jsonResponse<T>(endpoint: string, response: { ok(): boolean; status(): number; json(): Promise<unknown> }): Promise<T> {
  if (!response.ok()) throw responseFailure(endpoint, response);
  try {
    return await response.json() as T;
  } catch {
    throw new Error(`E2E authentication request ${endpoint} returned invalid JSON.`);
  }
}

function validUser(value: unknown): value is AccountUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const user = value as Partial<AccountUser>;
  return typeof user.id === 'string' && user.id.trim().length > 0
    && user.username === TEST_OWNER_USERNAME
    && user.role === 'admin'
    && user.enabled === true
    && typeof user.accessRevision === 'number';
}

function requireOwner(value: unknown, endpoint: string): AccountUser {
  if (!validUser(value)) throw new Error(`E2E authentication request ${endpoint} did not return the synthetic admin account.`);
  return value;
}

/**
 * Authenticate one isolated E2E API client and verify the resulting private
 * session. The first call creates the owner; later calls use the login path.
 */
export async function authenticateTestOwner(request: APIRequestContext): Promise<TestOwnerSession> {
  const statusResponse = await request.get('/api/auth/status');
  const status = await jsonResponse<AccountStatus>('/api/auth/status', statusResponse);
  if (status.enabled !== true) {
    throw new Error('E2E authentication requires account mode; /api/auth/status reported accounts disabled.');
  }
  if (typeof status.needsSetup !== 'boolean') {
    throw new Error('E2E authentication received an incomplete account status.');
  }

  const endpoint = status.needsSetup ? '/api/auth/setup' : '/api/auth/login';
  const authResponse = await request.post(endpoint, {
    data: { username: TEST_OWNER_USERNAME, password: TEST_OWNER_PASSWORD },
  });
  const authStatus = await jsonResponse<AccountStatus>(endpoint, authResponse);
  const user = requireOwner(authStatus.user, endpoint);
  if (authStatus.enabled !== true || authStatus.needsSetup !== false) {
    throw new Error(`E2E authentication request ${endpoint} returned an unexpected account state.`);
  }

  const sessionResponse = await request.get('/api/session');
  const session = await jsonResponse<SessionResponse>('/api/session', sessionResponse);
  if (typeof session.sourceId !== 'string' || session.sourceId.trim().length === 0
      || typeof session.writeToken !== 'string' || session.writeToken.trim().length === 0) {
    throw new Error('E2E authentication session is missing source or write credentials.');
  }
  if (session.user?.id !== user.id || session.user.username !== TEST_OWNER_USERNAME || session.user.role !== 'admin') {
    throw new Error('E2E authentication session does not identify the synthetic admin account.');
  }
  return { userId: user.id, sourceId: session.sourceId };
}

interface E2EFixtures {
  authenticatedSession: TestOwnerSession;
}

/**
 * Every browser test starts with the same isolated synthetic owner. The API
 * request fixture keeps the authenticated cookie for API assertions, and the
 * same cookie is copied into the fresh browser context in memory.
 */
export const test = base.extend<E2EFixtures>({
  authenticatedSession: [async ({ request, context }, use) => {
    const session = await authenticateTestOwner(request);
    const storage = await request.storageState();
    await context.addCookies(storage.cookies);

    const browserSessionResponse = await context.request.get('/api/session');
    const browserSession = await jsonResponse<SessionResponse>('/api/session', browserSessionResponse);
    if (browserSession.user?.id !== session.userId || browserSession.sourceId !== session.sourceId) {
      throw new Error('E2E browser context did not receive the synthetic admin session.');
    }
    await use(session);
  }, { auto: true }],
});

export { expect };
