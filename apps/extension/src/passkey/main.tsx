import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { lang } from '../shared/i18n';
import { preloadIcons } from '../popup/SiteIcon';
import { PasskeyApp } from './App';

document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
const requestId = new URLSearchParams(location.search).get('id') ?? '';

void preloadIcons().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PasskeyApp requestId={requestId} />
    </StrictMode>,
  );
});
