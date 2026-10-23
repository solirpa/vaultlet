import { describe, expect, it } from 'vitest';
import { pickLang, translate, translatedKeys } from '../shared/i18n';

describe('i18n', () => {
  it('follows navigator.language: zh* → Chinese, everything else → English', () => {
    for (const l of ['zh', 'zh-CN', 'zh-TW', 'zh-Hans-CN', 'ZH-cn']) expect(pickLang(l)).toBe('zh');
    for (const l of ['en-US', 'de', 'ja', '', undefined, null, 'zhx']) expect(pickLang(l)).toBe('en');
  });

  it('translates and interpolates', () => {
    expect(translate('zh', 'save.saveFor', { host: 'github.com' })).toBe('保存 github.com 的登录信息？');
    expect(translate('en', 'save.updateFor', { user: 'alice' })).toBe('Update password for alice?');
    expect(translate('zh', 'toast.copied', { what: '密码' })).toBe('已复制密码');
    expect(translate('en', 'vault.all')).toBe('All items');
    expect(translate('zh', 'vault.all')).toBe('所有项目');
  });

  it('leaves unknown placeholders alone and falls back to English, then to the key', () => {
    expect(translate('en', 'save.saveFor')).toBe('Save login for {host}?');
    expect(translate('en', 'save.saveFor', { other: 'x' })).toBe('Save login for {host}?');
    // a key with no Chinese entry falls back to English
    expect(translate('zh', 'nonexistent' as never)).toBe('nonexistent');
  });

  it('Chinese covers exactly the English keys', () => {
    const en = translatedKeys('en');
    const zh = translatedKeys('zh');
    expect(zh.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !zh.includes(k))).toEqual([]);
  });
});
