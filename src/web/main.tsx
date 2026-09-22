import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import AuthGate from './AuthGate';
import './styles.css';
import './account.css';
import './theme-controls.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Living Memory root element was not found.');
}

createRoot(root).render(
  <StrictMode>
    <AuthGate />
  </StrictMode>,
);
