import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate from './AuthGate';
import './styles.css';
import './account.css';
import './theme-controls.css';

const PerformancePage = lazy(() => import('./PerformancePage'));

const root = document.getElementById('root');

if (!root) {
  throw new Error('Living Memory root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    {window.location.pathname.replace(/\/$/, '') === '/performance'
      ? <Suspense fallback={<div className="loading-screen">正在准备合成性能页…</div>}><PerformancePage /></Suspense>
      : <AuthGate />}
  </StrictMode>,
);
