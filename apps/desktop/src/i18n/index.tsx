import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { Language } from '../types';
import { en, type I18nKey } from './en';
import { zhCN } from './zh-CN';

const dictionaries: Record<Language, Record<I18nKey, string>> = { en, 'zh-CN': zhCN };

export type { I18nKey };

export function detectLanguage(): Language {
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

type Params = Record<string, string | number>;

export type TFn = (key: I18nKey, params?: Params) => string;

interface I18nContextValue {
  lang: Language;
  setLang: (l: Language) => void;
  t: TFn;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, k: string) => (k in params ? String(params[k]) : `{${k}}`));
}

export function I18nProvider({ initial, children }: { initial?: Language; children: ReactNode }) {
  const [lang, setLangState] = useState<Language>(initial ?? detectLanguage());
  const setLang = useCallback((l: Language) => {
    setLangState(l);
    document.documentElement.lang = l;
  }, []);
  const t = useCallback<TFn>(
    (key, params) => format(dictionaries[lang][key] ?? en[key] ?? key, params),
    [lang],
  );
  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}

export function useT(): TFn {
  return useI18n().t;
}
