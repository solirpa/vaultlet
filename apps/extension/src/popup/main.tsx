import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { preloadIcons } from './SiteIcon';

// Seed persisted site icons first (bounded to ~80 ms) so rows render with icons, not a monogram flash.
void preloadIcons().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
