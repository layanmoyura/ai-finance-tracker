import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { PreferencesProvider } from './context/PreferencesContext';
import { AlertProvider } from './context/AlertContext';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PreferencesProvider>
      <AlertProvider>
        <App />
      </AlertProvider>
    </PreferencesProvider>
  </StrictMode>,
);
