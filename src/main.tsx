import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { PreferencesProvider } from './context/PreferencesContext';
import { Toaster } from 'sonner';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesProvider>
      <Toaster richColors position="top-right" closeButton />
      <App />
    </PreferencesProvider>
  </StrictMode>,
);
