import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App';
import { AppProvider } from './lib/app';
import { AuthProvider } from './lib/auth';
import './fonts';
import './index.css';

// The single-file demo build has no server to rewrite paths, so it routes on the hash.
const Router = import.meta.env.MODE === 'demo' ? HashRouter : BrowserRouter;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AppProvider>
        <Router>
          <App />
        </Router>
      </AppProvider>
    </AuthProvider>
  </StrictMode>,
);
