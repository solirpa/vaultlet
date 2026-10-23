/**
 * Inline autofill menu: keyboard/selection state as a pure reducer.
 *
 * The page's input keeps focus while the menu is open, so keys arrive on the
 * input; `menuKeyDown` decides which ones the menu consumes.
 */

export interface MenuState {
  open: boolean;
  /** number of selectable rows */
  count: number;
  /** highlighted row, -1 = none (Enter then belongs to the page, e.g. submits the form) */
  active: number;
}

export type MenuAction =
  | { type: 'open'; count: number }
  | { type: 'close' }
  | { type: 'set-count'; count: number }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'hover'; index: number };

export const initialMenuState: MenuState = { open: false, count: 0, active: -1 };

export function menuReducer(state: MenuState, action: MenuAction): MenuState {
  switch (action.type) {
    case 'open':
      return { open: true, count: Math.max(0, action.count), active: -1 };
    case 'close':
      return state.open || state.active !== -1 ? { ...state, open: false, active: -1 } : state;
    case 'set-count': {
      const count = Math.max(0, action.count);
      return { ...state, count, active: state.active < count ? state.active : count - 1 };
    }
    case 'move': {
      if (!state.open || state.count === 0) return state;
      if (state.active < 0) return { ...state, active: action.delta === 1 ? 0 : state.count - 1 };
      const next = (state.active + action.delta + state.count) % state.count; // wrap around
      return { ...state, active: next };
    }
    case 'hover':
      if (!state.open || action.index < 0 || action.index >= state.count) return state;
      return { ...state, active: action.index };
    default:
      return state;
  }
}

export interface KeyResult {
  state: MenuState;
  /** the key was consumed by the menu (caller should preventDefault + stop propagation) */
  handled: boolean;
  /** activate (fill / unlock) this row */
  activate?: number;
  /** menu is closed and the user asked for it (ArrowDown) */
  requestOpen?: boolean;
}

export function menuKeyDown(state: MenuState, key: string): KeyResult {
  if (!state.open) {
    if (key === 'ArrowDown') return { state, handled: true, requestOpen: true };
    return { state, handled: false };
  }
  switch (key) {
    case 'ArrowDown':
      return { state: menuReducer(state, { type: 'move', delta: 1 }), handled: true };
    case 'ArrowUp':
      return { state: menuReducer(state, { type: 'move', delta: -1 }), handled: true };
    case 'Enter':
      if (state.active < 0) return { state, handled: false };
      return { state: menuReducer(state, { type: 'close' }), handled: true, activate: state.active };
    case 'Escape':
      return { state: menuReducer(state, { type: 'close' }), handled: true };
    case 'Tab':
      // leave focus handling to the page, just get out of the way
      return { state: menuReducer(state, { type: 'close' }), handled: false };
    default:
      return { state, handled: false };
  }
}
