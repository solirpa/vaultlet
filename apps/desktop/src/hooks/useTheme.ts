import { useEffect } from 'react';
import type { ThemeSetting } from '../types';

function resolve(theme: ThemeSetting): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Applies data-theme on <html>; follows the OS when theme === 'system'. */
export function useTheme(theme: ThemeSetting): void {
  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolve(theme);
    };
    apply();
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}
