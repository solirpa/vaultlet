/**
 * Set an input's value in a way React/Vue/Angular notice: use the native value
 * setter (bypassing framework-patched setters) and dispatch input/change events.
 */
export function setNativeValue(input: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(input) as object;
  const desc =
    Object.getOwnPropertyDescriptor(proto, 'value') ??
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const setter = desc?.set;
  if (setter) setter.call(input, value);
  else input.value = value;
}

export function fillInput(input: HTMLInputElement, value: string): void {
  input.focus();
  setNativeValue(input, value);
  const init = { bubbles: true, cancelable: true } as const;
  const InputEv = typeof InputEvent === 'function' ? InputEvent : Event;
  input.dispatchEvent(new InputEv('input', { ...init, data: value, inputType: 'insertText' } as InputEventInit));
  input.dispatchEvent(new Event('change', init));
  input.dispatchEvent(new KeyboardEvent('keyup', init));
  input.blur();
}
