import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { VaultProvider } from './hooks/VaultContext';
import { ToastProvider } from './hooks/useToast';
import { I18nProvider } from './i18n';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ToastProvider>
        <VaultProvider>
          <App />
        </VaultProvider>
      </ToastProvider>
    </I18nProvider>
  </StrictMode>,
);
