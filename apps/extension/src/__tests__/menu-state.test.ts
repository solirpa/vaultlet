import { describe, expect, it } from 'vitest';
import { initialMenuState, menuKeyDown, menuReducer, type MenuState } from '../content/menu-state';

const open = (count: number): MenuState => menuReducer(initialMenuState, { type: 'open', count });

function keys(state: MenuState, ...ks: string[]): MenuState {
  return ks.reduce((s, k) => menuKeyDown(s, k).state, state);
}

describe('inline menu reducer', () => {
  it('opens with nothing highlighted', () => {
    expect(open(3)).toEqual({ open: true, count: 3, active: -1 });
  });

  it('ArrowDown / ArrowUp move and wrap around', () => {
    const s = open(3);
    expect(keys(s, 'ArrowDown').active).toBe(0);
    expect(keys(s, 'ArrowDown', 'ArrowDown').active).toBe(1);
    expect(keys(s, 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown').active).toBe(0);
    expect(keys(s, 'ArrowUp').active).toBe(2); // from nothing → last
    expect(keys(s, 'ArrowDown', 'ArrowUp').active).toBe(2); // 0 → wraps to last
  });

  it('arrow keys are consumed while open', () => {
    expect(menuKeyDown(open(2), 'ArrowDown').handled).toBe(true);
    expect(menuKeyDown(open(2), 'ArrowUp').handled).toBe(true);
  });

  it('Enter activates the highlighted row and closes', () => {
    const s = keys(open(3), 'ArrowDown', 'ArrowDown');
    const r = menuKeyDown(s, 'Enter');
    expect(r).toMatchObject({ handled: true, activate: 1 });
    expect(r.state.open).toBe(false);
  });

  it('Enter without a highlighted row is left to the page (form submit)', () => {
    const r = menuKeyDown(open(3), 'Enter');
    expect(r.handled).toBe(false);
    expect(r.activate).toBeUndefined();
    expect(r.state.open).toBe(true);
  });

  it('Escape closes and is consumed; Tab closes but is not consumed', () => {
    const esc = menuKeyDown(keys(open(2), 'ArrowDown'), 'Escape');
    expect(esc.handled).toBe(true);
    expect(esc.state).toMatchObject({ open: false, active: -1 });
    const tab = menuKeyDown(open(2), 'Tab');
    expect(tab.handled).toBe(false);
    expect(tab.state.open).toBe(false);
  });

  it('while closed only ArrowDown is consumed (to open the menu)', () => {
    expect(menuKeyDown(initialMenuState, 'ArrowDown')).toMatchObject({ handled: true, requestOpen: true });
    for (const k of ['ArrowUp', 'Enter', 'Escape', 'a']) {
      expect(menuKeyDown(initialMenuState, k)).toMatchObject({ handled: false });
    }
  });

  it('other keys pass through while open', () => {
    const r = menuKeyDown(open(2), 'a');
    expect(r.handled).toBe(false);
    expect(r.state.open).toBe(true);
  });

  it('a menu without selectable rows ignores arrows', () => {
    const s = open(0);
    expect(keys(s, 'ArrowDown', 'ArrowUp').active).toBe(-1);
    expect(menuKeyDown(s, 'Enter').handled).toBe(false);
  });

  it('hover highlights valid rows only', () => {
    const s = open(2);
    expect(menuReducer(s, { type: 'hover', index: 1 }).active).toBe(1);
    expect(menuReducer(s, { type: 'hover', index: 5 }).active).toBe(-1);
    expect(menuReducer(initialMenuState, { type: 'hover', index: 0 }).active).toBe(-1);
  });

  it('set-count keeps the highlight in range when rows shrink', () => {
    const s = keys(open(5), 'ArrowUp'); // active 4
    expect(menuReducer(s, { type: 'set-count', count: 2 }).active).toBe(1);
    expect(menuReducer(s, { type: 'set-count', count: 0 }).active).toBe(-1);
  });
});
