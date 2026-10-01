import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import type { AccountDirectory, AccountStatus, AccountUser } from '../shared/accounts';
import { api } from './api';
import { ThemeProvider } from './ThemeProvider';
import { ThemeSelector } from './ThemeSelector';

const AUTH_CHANGED_KEY = 'living-memory.auth-changed.v1';
const AUTH_CHANGED_MESSAGE = 'changed';
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;

export type AuthGateView = 'checking' | 'legacy' | 'setup' | 'login' | 'authenticated' | 'error';

export interface AuthenticatedAppProps {
  account: AccountUser;
  onLogout: () => void;
  onManageAccounts: () => void;
}

/** App now accepts the authenticated account callbacks while keeping legacy props optional. */
const AccountApp = lazy(() => import('./App'));
const LegacyApp = AccountApp;

export function validateUsername(value: string): string | null {
  if (value.length < 3 || value.length > 32) return '用户名需要是 3 到 32 个字符。';
  if (!USERNAME_PATTERN.test(value)) return '用户名只能使用字母、数字、点、下划线和短横线，且必须以字母或数字开头。';
  return null;
}

export function validatePassword(value: string): string | null {
  const length = [...value].length;
  if (length < 12 || length > 256) return '密码需要是 12 到 256 个字符。';
  return null;
}

function passwordInputValue(value: string): string {
  return [...value].slice(0, 256).join('');
}

export function accountStatusKey(status: AccountStatus | null): string {
  if (!status) return 'none';
  const user = status.user;
  return [
    status.enabled ? 'enabled' : 'legacy',
    status.needsSetup ? 'setup' : 'ready',
    user?.id ?? '',
    user?.accessRevision ?? '',
    user?.enabled ? 'on' : 'off',
  ].join(':');
}

function validUser(value: unknown): value is AccountUser {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === 'string' && candidate.id.trim().length > 0
    && typeof candidate.username === 'string' && candidate.username.trim().length > 0
    && (candidate.role === 'admin' || candidate.role === 'member')
    && typeof candidate.enabled === 'boolean'
    && typeof candidate.accessRevision === 'number'
    && Number.isSafeInteger(candidate.accessRevision) && candidate.accessRevision >= 0;
}

export function parseAccountStatus(value: unknown): AccountStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('认证服务返回的数据无效。');
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.needsSetup !== 'boolean') {
    throw new Error('认证服务返回的数据不完整。');
  }
  if (candidate.user !== null && !validUser(candidate.user)) throw new Error('认证服务返回的用户信息无效。');
  return {
    enabled: candidate.enabled,
    needsSetup: candidate.needsSetup,
    user: candidate.user as AccountUser | null,
  };
}

class AuthHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = 'AUTH_REQUEST_FAILED') {
    super(message);
    this.name = 'AuthHttpError';
    this.status = status;
    this.code = code;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : '请求没有完成，请稍后重试。';
}

async function responseError(response: Response): Promise<AuthHttpError> {
  let message = `请求失败（${response.status}）`;
  let code = 'AUTH_REQUEST_FAILED';
  try {
    const body: unknown = await response.json();
    if (body && typeof body === 'object' && !Array.isArray(body) && 'error' in body) {
      const error = (body as { error?: { message?: unknown; code?: unknown } }).error;
      if (typeof error?.message === 'string' && error.message.trim()) message = error.message;
      if (typeof error?.code === 'string' && error.code.trim()) code = error.code;
    }
  } catch {
    // Keep the status-based message when the service returned no JSON body.
  }
  return new AuthHttpError(message, response.status, code);
}

async function authRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new AuthHttpError('认证服务暂时不可达，请检查服务是否正在运行。', 0, 'NETWORK_OFFLINE');
  }
  if (!response.ok) throw await responseError(response);
  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

async function readAuthStatus(): Promise<AccountStatus> {
  return parseAccountStatus(await authRequest<unknown>('/auth/status'));
}

function announceAuthChange(): void {
  if (typeof window === 'undefined') return;
  // Only an opaque timestamp announces an auth change. Credentials stay in the
  // authenticated session; browser preferences never establish account identity.
  try { window.localStorage.setItem(AUTH_CHANGED_KEY, String(Date.now())); } catch { /* private storage may be unavailable */ }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel('living-memory-auth');
      channel.postMessage(AUTH_CHANGED_MESSAGE);
      channel.close();
    }
  } catch { /* BroadcastChannel is optional. */ }
}

function isAuthRequired(error: unknown): boolean {
  return error instanceof AuthHttpError && (error.status === 401 || error.code === 'AUTH_REQUIRED' || error.code === 'SESSION_EXPIRED');
}

function useAuthStatusEvents(
  checkStatus: (options?: { initial?: boolean; force?: boolean }) => Promise<void>,
  onAuthRequired: () => void,
): void {
  useEffect(() => {
    const onRequired = () => onAuthRequired();
    const onStorage = (event: StorageEvent) => {
      if (event.key === AUTH_CHANGED_KEY) void checkStatus({ force: true });
    };
    const onFocus = () => void checkStatus();
    const onVisibility = () => { if (!document.hidden) void checkStatus(); };
    const onBroadcast = () => void checkStatus({ force: true });
    let channel: BroadcastChannel | null = null;
    window.addEventListener('lm-auth-required', onRequired);
    window.addEventListener('storage', onStorage);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('living-memory-auth');
        channel.addEventListener('message', onBroadcast);
      }
    } catch { channel = null; }
    return () => {
      window.removeEventListener('lm-auth-required', onRequired);
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      channel?.close();
    };
  }, [checkStatus, onAuthRequired]);
}

function LoginForm({ setup, busy, error, onSubmit }: {
  setup: boolean;
  busy: boolean;
  error: string | null;
  onSubmit: (username: string, password: string) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [validation, setValidation] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const usernameError = validateUsername(username);
    const passwordError = validatePassword(password);
    const nextError = usernameError ?? passwordError;
    if (nextError) {
      setValidation(nextError);
      return;
    }
    setValidation(null);
    onSubmit(username, password);
    setPassword('');
  };

  return (
    <main className="auth-shell">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand"><span className="auth-mark" aria-hidden="true"><i /><i /><i /></span><span>Living Memory</span></div>
        <p className="auth-kicker">私人知识记忆空间</p>
        <h1 id="auth-title">{setup ? '创建第一个账户' : '登录你的知识空间'}</h1>
        <p className="auth-intro">{setup ? '第一个账户会成为管理员，并接管当前已有的私人知识与学习历史。' : '登录后只会显示属于当前账户的私人知识图谱和学习记录。'}</p>
        <form className="auth-form" onSubmit={submit} noValidate>
          <label htmlFor="auth-username">用户名</label>
          <input id="auth-username" name="username" type="text" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={32} required disabled={busy} />
          <label htmlFor="auth-password">密码</label>
          <input id="auth-password" name="password" type="password" value={password} onChange={(event) => setPassword(passwordInputValue(event.target.value))} autoComplete={setup ? 'new-password' : 'current-password'} minLength={12} required disabled={busy} />
          {validation || error ? <p className="auth-error" role="alert">{validation ?? error}</p> : null}
          <button type="submit" className="auth-primary-button" disabled={busy}>{busy ? '处理中…' : setup ? '创建账户并进入' : '登录'}</button>
        </form>
        <p className="auth-footnote">用户名 3–32 个 ASCII 字符；密码 12–256 个字符。</p>
        <div className="auth-theme-row"><ThemeSelector /></div>
      </section>
    </main>
  );
}

function AdminDialog({ open, user, onClose, onAuthRequired }: {
  open: boolean;
  user: AccountUser;
  onClose: () => void;
  onAuthRequired: () => void;
}) {
  const [directory, setDirectory] = useState<AccountDirectory | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newValidation, setNewValidation] = useState<string | null>(null);
  const [resetPasswords, setResetPasswords] = useState<Record<string, string>>({});
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const adminRequest = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const session = await api.getSession();
    return authRequest<T>(path, {
      ...init,
      headers: {
        'X-LM-Token': session.writeToken,
        'X-LM-Source-ID': session.sourceId,
        ...init.headers,
      },
    });
  }, []);

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setDirectory(await adminRequest<AccountDirectory>('/admin/users', { method: 'GET' }));
    } catch (loadError) {
      if (isAuthRequired(loadError)) onAuthRequired();
      setError(errorText(loadError));
    } finally {
      setLoading(false);
    }
  }, [adminRequest, onAuthRequired]);

  useEffect(() => {
    if (open) void loadDirectory();
  }, [loadDirectory, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open, saving]);

  if (!open) return null;

  const createAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const usernameError = validateUsername(newUsername);
    const passwordError = validatePassword(newPassword);
    const nextError = usernameError ?? passwordError;
    if (nextError) { setNewValidation(nextError); return; }
    setNewValidation(null);
    setSaving(true);
    setError(null);
    try {
      await adminRequest('/admin/users', { method: 'POST', body: JSON.stringify({ username: newUsername, password: newPassword }) });
      setNewUsername('');
      setNewPassword('');
      await loadDirectory();
      announceAuthChange();
    } catch (createError) {
      if (isAuthRequired(createError)) onAuthRequired();
      setError(errorText(createError));
    } finally {
      setSaving(false);
    }
  };

  const setEnabled = async (account: AccountUser) => {
    setSaving(true);
    setError(null);
    try {
      await adminRequest(`/admin/users/${encodeURIComponent(account.id)}`, { method: 'PUT', body: JSON.stringify({ enabled: !account.enabled }) });
      await loadDirectory();
      announceAuthChange();
    } catch (updateError) {
      if (isAuthRequired(updateError)) onAuthRequired();
      setError(errorText(updateError));
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async (account: AccountUser) => {
    const password = resetPasswords[account.id] ?? '';
    const passwordError = validatePassword(password);
    if (passwordError) { setError(`${account.username}：${passwordError}`); return; }
    setSaving(true);
    setError(null);
    try {
      await adminRequest(`/admin/users/${encodeURIComponent(account.id)}`, { method: 'PUT', body: JSON.stringify({ password }) });
      setResetPasswords((current) => ({ ...current, [account.id]: '' }));
      setError(null);
    } catch (updateError) {
      if (isAuthRequired(updateError)) onAuthRequired();
      setError(errorText(updateError));
    } finally {
      setSaving(false);
    }
  };

  const copyAccountId = async (id: string) => {
    try {
      if (!navigator.clipboard) throw new Error('当前浏览器不支持复制。');
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setError(null);
    } catch (copyError) {
      setError(errorText(copyError));
    }
  };

  return (
    <div className="auth-modal-layer" role="presentation">
      <dialog ref={dialogRef} className="auth-dialog" open aria-modal="true" aria-labelledby="account-admin-title" tabIndex={-1}>
        <div className="auth-dialog-heading"><div><span className="auth-kicker">管理员设置</span><h2 id="account-admin-title">账户管理</h2></div><button type="button" className="auth-close-button" onClick={onClose} disabled={saving} aria-label="关闭账户管理">×</button></div>
        <p className="auth-dialog-note">新账号会获得独立的私人知识空间；知识暂由本地 Markdown 目录导入，具体路径见运行说明。</p>
        <form className="admin-create-form" onSubmit={createAccount} noValidate>
          <h3>创建成员账户</h3>
          <div className="admin-form-grid"><label htmlFor="new-account-username">用户名<input id="new-account-username" type="text" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} autoComplete="off" minLength={3} maxLength={32} disabled={saving} /></label><label htmlFor="new-account-password">初始密码<input id="new-account-password" type="password" value={newPassword} onChange={(event) => setNewPassword(passwordInputValue(event.target.value))} autoComplete="new-password" minLength={12} disabled={saving} /></label></div>
          {newValidation ? <p className="auth-error" role="alert">{newValidation}</p> : null}
          <button type="submit" className="auth-secondary-button" disabled={saving}>创建成员</button>
        </form>
        <section className="admin-users" aria-labelledby="admin-users-heading"><div className="admin-section-heading"><h3 id="admin-users-heading">现有账户</h3><button type="button" className="auth-link-button" onClick={() => void loadDirectory()} disabled={loading || saving}>{loading ? '读取中…' : '重新读取'}</button></div>{loading && !directory ? <p className="auth-muted">正在读取账户列表…</p> : null}{directory?.users.map((account) => <article className="admin-user-row" key={account.id}><div className="admin-user-meta"><strong>{account.username}</strong><span>{account.role === 'admin' ? '管理员' : '成员'} · {account.enabled ? '已启用' : '已停用'}{account.id === user.id ? ' · 当前账户' : ''}</span><code className="admin-user-id" title="账户 ID">{account.id}</code></div><div className="admin-user-actions"><button type="button" className="auth-link-button" onClick={() => void copyAccountId(account.id)} disabled={saving}>{copiedId === account.id ? '已复制' : '复制 ID'}</button><button type="button" className="auth-link-button" onClick={() => void setEnabled(account)} disabled={saving}>{account.enabled ? '停用' : '启用'}</button><label className="admin-reset-field"><span className="visually-hidden">为 {account.username} 设置新密码</span><input type="password" value={resetPasswords[account.id] ?? ''} onChange={(event) => setResetPasswords((current) => ({ ...current, [account.id]: passwordInputValue(event.target.value) }))} placeholder="新密码" autoComplete="new-password" minLength={12} disabled={saving} /><button type="button" className="auth-link-button" onClick={() => void resetPassword(account)} disabled={saving}>重置密码</button></label></div></article>)}{directory && directory.users.length === 0 ? <p className="auth-muted">暂无账户。</p> : null}</section>
        {error ? <p className="auth-error" role="alert">{error}</p> : null}
      </dialog>
    </div>
  );
}

export function AuthGate(): ReactElement {
  const [view, setView] = useState<AuthGateView>('checking');
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const statusRef = useRef<AccountStatus | null>(null);
  const viewRef = useRef<AuthGateView>('checking');
  const requestRef = useRef(0);
  const statusCheckRef = useRef<Promise<void> | null>(null);

  const applyStatus = useCallback((next: AccountStatus, options: { initial?: boolean } = {}) => {
    const previous = statusRef.current;
    const sameUser = previous?.user?.id === next.user?.id
      && previous?.user?.accessRevision === next.user?.accessRevision;
    statusRef.current = next;
    setStatus(next);
    if (!sameUser || next.user?.role !== 'admin') setAdminOpen(false);
    if (!next.enabled) {
      viewRef.current = 'legacy';
      setView('legacy');
      setError(null);
      return;
    }
    if (next.needsSetup) {
      viewRef.current = 'setup';
      setView('setup');
      setError(null);
      return;
    }
    if (next.user?.enabled) {
      if (sameUser && viewRef.current === 'authenticated' && !options.initial) return;
      viewRef.current = 'authenticated';
      setView('authenticated');
      setError(null);
      return;
    }
    viewRef.current = 'login';
    setView('login');
  }, []);

  const checkStatus = useCallback((options: { initial?: boolean; force?: boolean } = {}): Promise<void> => {
    // Several writes can fail together when a cookie expires or a source
    // changes. Share one status request so the auth event cannot create a
    // self-sustaining recheck loop.
    if (statusCheckRef.current) return statusCheckRef.current;
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    if (options.initial) {
      viewRef.current = 'checking';
      setView('checking');
      setError(null);
    }
    const task = (async () => {
      try {
        const next = await readAuthStatus();
        if (requestId !== requestRef.current) return;
        applyStatus(next, { initial: options.initial });
      } catch (statusError) {
        if (requestId !== requestRef.current) return;
        if (options.force || options.initial || !statusRef.current?.user) {
          viewRef.current = 'error';
          setView('error');
          setError(errorText(statusError));
        }
        // A transient focus check must not tear down an otherwise valid App.
      }
    })();
    const tracked = task.finally(() => {
      if (statusCheckRef.current === tracked) statusCheckRef.current = null;
    });
    statusCheckRef.current = tracked;
    return tracked;
  }, [applyStatus]);

  const invalidateStatusChecks = useCallback(() => {
    // A request that started before login/logout must not be allowed to apply
    // its old user:null or old-user response after the credential transition.
    requestRef.current += 1;
    statusCheckRef.current = null;
  }, []);

  useEffect(() => {
    void checkStatus({ initial: true });
  }, [checkStatus]);

  const submitCredentials = useCallback(async (username: string, password: string) => {
    setBusy(true);
    setError(null);
    const setup = viewRef.current === 'setup';
    try {
      const next = parseAccountStatus(await authRequest<unknown>(setup ? '/auth/setup' : '/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }));
      invalidateStatusChecks();
      announceAuthChange();
      applyStatus(next);
    } catch (authError) {
      if (isAuthRequired(authError)) void checkStatus({ force: true });
      setError(errorText(authError));
    } finally {
      setBusy(false);
    }
  }, [applyStatus, checkStatus, invalidateStatusChecks]);

  const logout = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setAdminOpen(false);
    invalidateStatusChecks();
    // Unmount App before waiting for the network, so an old user's graph and
    // draft are never visible while the cookie is being invalidated.
    statusRef.current = null;
    viewRef.current = 'checking';
    setStatus(null);
    setView('checking');
    setError(null);
    try {
      let session: { writeToken: string; sourceId: string } | null = null;
      try { session = await api.getSession(); } catch { /* an expired cookie can still be cleared by logout */ }
      await authRequest('/auth/logout', {
        method: 'POST',
        ...(session ? { headers: { 'X-LM-Token': session.writeToken, 'X-LM-Source-ID': session.sourceId } } : {}),
      });
      announceAuthChange();
    } catch (logoutError) {
      // Always re-check status. If the server already cleared the cookie this
      // returns the login screen; otherwise it restores the still-valid App.
      setError(errorText(logoutError));
    } finally {
      setBusy(false);
      await checkStatus({ force: true });
    }
  }, [busy, checkStatus, invalidateStatusChecks]);

  const openAdmin = useCallback(() => {
    if (statusRef.current?.user?.role === 'admin') setAdminOpen(true);
  }, []);

  const authRequired = useCallback(() => {
    setAdminOpen(false);
    // SOURCE_MISMATCH currently shares this event with AUTH_REQUIRED. Keep
    // the graph mounted until status tells us that the account really changed;
    // otherwise a source refresh would repeatedly remount App and emit the
    // same event forever.
    invalidateStatusChecks();
    void checkStatus({ force: true });
  }, [checkStatus, invalidateStatusChecks]);

  useAuthStatusEvents(checkStatus, authRequired);

  const account = view === 'authenticated' && status?.user?.enabled ? status.user : null;
  let content: ReactElement;
  if (view === 'legacy') {
    content = <Suspense fallback={<AuthLoading text="正在加载知识空间…" />}><LegacyApp /></Suspense>;
  } else if (view === 'checking') {
    content = <AuthLoading text="正在检查账户会话…" />;
  } else if (view === 'error') {
    content = <main className="auth-shell"><section className="auth-card" role="alert"><div className="auth-brand"><span className="auth-mark" aria-hidden="true"><i /><i /><i /></span><span>Living Memory</span></div><h1>无法检查账户</h1><p className="auth-intro">{error ?? '认证服务暂时不可用。'}</p><button type="button" className="auth-primary-button" onClick={() => void checkStatus({ initial: true })} disabled={busy}>重新检查</button><div className="auth-theme-row"><ThemeSelector /></div></section></main>;
  } else if (view === 'setup' || view === 'login' || !account) {
    content = <LoginForm setup={view === 'setup'} busy={busy} error={error ?? (view === 'authenticated' ? '当前会话没有可用账户，请重新登录。' : null)} onSubmit={(username, password) => void submitCredentials(username, password)} />;
  } else {
    content = <>
      <div className="auth-app-frame" inert={adminOpen ? true : undefined} aria-hidden={adminOpen ? true : undefined}>
        <Suspense fallback={<AuthLoading text="正在加载私人知识空间…" />}><AccountApp key={`${account.id}:${account.accessRevision}`} account={account} onLogout={() => void logout()} onManageAccounts={openAdmin} /></Suspense>
      </div>
      <AdminDialog open={adminOpen} user={account} onClose={() => setAdminOpen(false)} onAuthRequired={authRequired} />
      {error ? <div className="auth-session-warning" role="alert">{error}<button type="button" onClick={() => void checkStatus({ force: true })}>重新检查</button></div> : null}
    </>;
  }
  return <ThemeProvider userId={account?.id ?? null}>{content}</ThemeProvider>;
}

function AuthLoading({ text }: { text: string }) {
  return <main className="auth-shell"><section className="auth-card auth-loading" role="status"><div className="auth-brand"><span className="auth-mark" aria-hidden="true"><i /><i /><i /></span><span>Living Memory</span></div><strong>{text}</strong><div className="auth-theme-row"><ThemeSelector /></div></section></main>;
}

export default AuthGate;
