import { describe, expect, it } from 'vitest';
import { buildSearchItems, buildVaultItems, displayHost, layout, visibleRange, ITEM_HEIGHT, type ListItem } from '../popup/sections';
import type { LoginSummary } from '../shared/protocol';

const s = (id: string, favorite = false): LoginSummary => ({ id, title: id, username: 'u', url: 'https://x.test', totp: false, favorite });
const shape = (items: ListItem[]) =>
  items.map((i) => (i.kind === 'header' ? `H:${i.section}${i.count !== undefined ? `(${i.count})` : ''}` : i.kind === 'note' ? `N:${i.note}` : `R:${i.section}:${i.entry.id}`));

describe('popup sections', () => {
  it('suggestions, favorites and all items when the search is empty', () => {
    const items = buildVaultItems({ isWebPage: true, suggestions: [s('gh')], list: [s('a', true), s('b'), s('gh')] });
    expect(shape(items)).toEqual(['H:suggestions(1)', 'R:suggestions:gh', 'H:favorites(1)', 'R:favorites:a', 'H:all(3)', 'R:all:a', 'R:all:b', 'R:all:gh']);
  });

  it('a one-line note instead of an empty suggestions block', () => {
    expect(shape(buildVaultItems({ isWebPage: false, suggestions: [], list: [s('a')] })).slice(0, 2)).toEqual(['H:suggestions', 'N:not-web']);
    expect(shape(buildVaultItems({ isWebPage: true, suggestions: [], list: [s('a')] })).slice(0, 2)).toEqual(['H:suggestions', 'N:no-match']);
    expect(shape(buildVaultItems({ isWebPage: true, suggestions: null, list: [s('a')] })).slice(0, 2)).toEqual(['H:suggestions', 'N:loading']);
  });

  it('hides Favorites when there are none; handles loading / empty / error lists', () => {
    expect(shape(buildVaultItems({ isWebPage: false, suggestions: [], list: [s('a')] }))).toEqual(['H:suggestions', 'N:not-web', 'H:all(1)', 'R:all:a']);
    expect(shape(buildVaultItems({ isWebPage: false, suggestions: [], list: null })).slice(2)).toEqual(['H:all', 'N:loading']);
    expect(shape(buildVaultItems({ isWebPage: false, suggestions: [], list: [] })).slice(2)).toEqual(['H:all(0)', 'N:empty']);
    const err = buildVaultItems({ isWebPage: false, suggestions: [], list: null, listError: 'boom' });
    expect(err.at(-1)).toMatchObject({ kind: 'note', note: 'error', text: 'boom' });
  });

  it('row keys are unique even when an entry appears in several sections', () => {
    const items = buildVaultItems({ isWebPage: true, suggestions: [s('a', true)], list: [s('a', true)] });
    const keys = items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('search results replace the sections', () => {
    expect(shape(buildSearchItems([s('x'), s('y')]))).toEqual(['H:results(2)', 'R:results:x', 'R:results:y']);
    expect(shape(buildSearchItems([]))).toEqual(['H:results', 'N:no-results']);
    expect(shape(buildSearchItems(null))).toEqual(['H:results', 'N:loading']);
    expect(shape(buildSearchItems(null, 'nope'))).toEqual(['H:results', 'N:error']);
  });

  it('windowing renders only rows near the viewport (224 items)', () => {
    const list = Array.from({ length: 224 }, (_, i) => s(`e${i}`));
    const items = buildVaultItems({ isWebPage: false, suggestions: [], list });
    const lay = layout(items);
    expect(lay.total).toBe(ITEM_HEIGHT.header * 2 + ITEM_HEIGHT.note + ITEM_HEIGHT.row * 224);
    const [start, end] = visibleRange(lay, 0, 440, 0);
    expect(start).toBe(0);
    expect(end - start).toBeLessThan(15);
    const [s2, e2] = visibleRange(lay, 5000, 440, 0);
    expect(lay.offsets[s2]).toBeLessThanOrEqual(5000);
    expect(lay.offsets[s2] + ITEM_HEIGHT[items[s2].kind]).toBeGreaterThan(5000);
    expect(lay.offsets[e2 - 1]).toBeLessThan(5440);
    expect(visibleRange(layout([]), 0, 440)).toEqual([0, 0]);
  });

  it('displayHost', () => {
    expect(displayHost('https://www.github.com/login')).toBe('github.com');
    expect(displayHost('not a url')).toBe('');
    expect(displayHost(undefined)).toBe('');
  });
});
