import { Eye, EyeOff, Loader2, X } from 'lucide-react';
import {
  forwardRef,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from '../lib/utils';
import { useT } from '../i18n';

type Variant = 'primary' | 'secondary' | 'tonal' | 'ghost' | 'subtle' | 'link' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
  /** Fully rounded (pill) shape. */
  pill?: boolean;
}

const variantCls: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:bg-accent-hover active:brightness-95 disabled:hover:bg-accent',
  secondary: 'bg-surface-2 text-text hover:bg-surface-3 active:bg-pressed',
  tonal: 'bg-accent-soft text-accent hover:bg-accent-soft-2',
  ghost: 'bg-transparent text-text hover:bg-hover active:bg-pressed',
  subtle: 'bg-transparent text-muted hover:bg-hover hover:text-text active:bg-pressed',
  link: 'bg-transparent text-accent hover:bg-accent-soft',
  danger: 'bg-surface-2 text-danger hover:bg-danger-soft',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, pill, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || loading}
      className={cx(
        'tr inline-flex items-center justify-center gap-1.5 font-medium whitespace-nowrap select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-45',
        size === 'sm' ? 'h-7 px-3 text-xs' : 'h-8 px-3.5 text-[13px]',
        pill ? 'rounded-full' : size === 'sm' ? 'rounded-md' : 'rounded-lg',
        variantCls[variant],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 size={14} className="animate-spin-slow" /> : icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  size?: Size;
  /** Visual tone: ghost (default) or primary filled. */
  tone?: 'ghost' | 'primary' | 'tonal';
}

export function IconButton({ label, active, size = 'md', tone = 'ghost', className, children, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={cx(
        'tr inline-flex shrink-0 items-center justify-center rounded-full select-none',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40',
        size === 'sm' ? 'h-6 w-6' : 'h-7 w-7',
        tone === 'primary'
          ? 'bg-accent text-accent-fg hover:bg-accent-hover'
          : tone === 'tonal'
            ? 'bg-accent-soft text-accent hover:bg-accent-soft-2'
            : cx('text-muted hover:bg-hover hover:text-text active:bg-pressed', active && 'text-accent hover:text-accent'),
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Filled input. `inset` flips to the surface tone for use inside a surface-2 block. */
export const inputCls =
  'tr h-8 w-full rounded-lg bg-surface-2 px-3 text-[13px] text-text ' +
  'placeholder:text-faint focus:outline-none focus:ring-2 focus:ring-ring ' +
  'disabled:opacity-50 [&:is(input,textarea):read-only]:text-muted';
export const inputInsetCls = 'bg-surface shadow-[inset_0_0_0_1px_var(--c-hairline)]';

type InsetProp = { inset?: boolean };

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & InsetProp>(function Input(
  { className, inset, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(inputCls, inset && inputInsetCls, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement> & InsetProp>(
  function Textarea({ className, inset, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx(inputCls, inset && inputInsetCls, 'h-auto min-h-[76px] resize-y py-2 leading-relaxed', className)}
        {...rest}
      />
    );
  },
);

export function Select({ className, inset, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & InsetProp) {
  return (
    <select
      className={cx(inputCls, inset && inputInsetCls, 'cursor-default appearance-none bg-no-repeat pr-7', className)}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238a8a92' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>\")",
        backgroundPosition: 'right 9px center',
      }}
      {...rest}
    >
      {children}
    </select>
  );
}

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>, InsetProp {
  revealed?: boolean;
  onRevealChange?: (v: boolean) => void;
}

export const PasswordInput = forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  { className, inset, revealed, onRevealChange, ...rest },
  ref,
) {
  const t = useT();
  const [internal, setInternal] = useState(false);
  const shown = revealed ?? internal;
  const toggle = () => (onRevealChange ? onRevealChange(!shown) : setInternal(!shown));
  return (
    <div className={cx('relative', className)}>
      <input
        ref={ref}
        type={shown ? 'text' : 'password'}
        className={cx(inputCls, inset && inputInsetCls, 'pr-8', shown && 'font-mono')}
        autoComplete="off"
        spellCheck={false}
        {...rest}
      />
      <IconButton
        label={shown ? t('common.hide') : t('common.show')}
        size="sm"
        className="absolute top-1 right-1"
        onClick={toggle}
        tabIndex={-1}
      >
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </IconButton>
    </div>
  );
});

/** macOS-style switch. */
export function Switch({
  checked,
  onChange,
  disabled,
  id,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'tr relative h-[20px] w-[34px] shrink-0 rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-accent' : 'bg-track',
        disabled && 'opacity-50',
      )}
    >
      <span
        className={cx(
          'absolute top-[2px] left-[2px] h-[16px] w-[16px] rounded-full bg-white',
          'transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)]',
          checked && 'translate-x-[14px]',
        )}
        style={{ boxShadow: 'var(--shadow-knob)' }}
      />
    </button>
  );
}

/** Labelled switch row (kept under the old name so existing call sites work). */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cx('flex min-h-[40px] cursor-default items-center justify-between gap-4 py-2', disabled && 'opacity-50')}>
      <span className="min-w-0">
        <span className="block text-[13px] text-text">{label}</span>
        {description && <span className="block text-xs text-muted">{description}</span>}
      </span>
      <Switch id={id} checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

export function FieldLabel({ children, hint, htmlFor, className }: { children: ReactNode; hint?: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <label htmlFor={htmlFor} className={cx('mb-1.5 block text-[12px] font-medium text-muted', className)}>
      {children}
      {hint && <span className="ml-1 font-normal text-faint">({hint})</span>}
    </label>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cx('mb-2 flex h-6 items-center justify-between', className)}>
      <h3 className="text-[11px] font-semibold text-muted">{children}</h3>
      {action}
    </div>
  );
}

/** Grouped block: a surface-2 slab with hairline-separated rows. */
export function Group({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('rows rounded-xl bg-surface-2', className)}>{children}</div>;
}

/** A labelled row inside a Group: label above value, actions on the right. */
export function GroupRow({
  label,
  children,
  actions,
  className,
  align = 'center',
}: {
  label?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
  align?: 'center' | 'start';
}) {
  return (
    <div className={cx('group flex min-h-[44px] gap-3 px-3.5 py-2', align === 'center' ? 'items-center' : 'items-start', className)}>
      <div className="min-w-0 flex-1">
        {label && <div className="mb-0.5 text-[11px] leading-4 text-muted">{label}</div>}
        {children}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

/** Tonal selectable tile: surface-2 at rest, accent-soft + 1px accent ring (40%) when selected. */
export const tileCls = (selected: boolean) =>
  cx(
    'tr rounded-xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    selected ? 'bg-accent-soft shadow-[inset_0_0_0_1px_var(--c-ring-soft)]' : 'bg-surface-2 hover:bg-surface-3',
  );

/** Small status pill with a soft tint. */
export function StatusPill({ tone, icon, children }: { tone: 'success' | 'warning' | 'danger' | 'accent' | 'neutral'; icon?: ReactNode; children: ReactNode }) {
  const cls = {
    success: 'bg-success-soft text-success',
    warning: 'bg-warning-soft text-warning',
    danger: 'bg-danger-soft text-danger',
    accent: 'bg-accent-soft text-accent',
    neutral: 'bg-surface-2 text-muted',
  }[tone];
  return (
    <span className={cx('inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium', cls)}>
      {icon}
      {children}
    </span>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  if (!children) return null;
  return <p className="mt-1.5 text-xs text-danger">{children}</p>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 size={16} className={cx('animate-spin-slow text-muted', className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md bg-surface-3 px-1.5 py-px font-sans text-[10px] font-medium text-muted">{children}</kbd>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 'max-w-md',
  closeOnBackdrop = true,
  padded = true,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: string;
  closeOnBackdrop?: boolean;
  padded?: boolean;
}) {
  const t = useT();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <Backdrop onClose={closeOnBackdrop ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx('elev-modal animate-modal w-full rounded-[14px]', width)}
      >
        {title !== undefined && (
          <div className="flex items-center justify-between px-5 pt-4 pb-1">
            <h2 className="text-[15px] font-semibold">{title}</h2>
            <IconButton label={t('common.close')} onClick={onClose}>
              <X size={15} />
            </IconButton>
          </div>
        )}
        <div className={cx(padded && 'p-5')}>{children}</div>
      </div>
    </Backdrop>
  );
}

/** Dimmed + blurred backdrop used by every dialog. */
export function Backdrop({ children, onClose, className }: { children: ReactNode; onClose?: () => void; className?: string }) {
  return (
    <div
      className={cx('animate-fade fixed inset-0 z-50 flex items-center justify-center p-6 backdrop-blur-[6px]', className)}
      style={{ background: 'var(--c-backdrop)' }}
      onMouseDown={(e) => {
        if (onClose && e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  confirmLabel?: ReactNode;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Modal open={open} onClose={onCancel} width="max-w-[360px]">
      <p className="text-[14px] font-semibold">{title}</p>
      {body && <p className="mt-1 text-xs text-muted">{body}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} autoFocus>
          {confirmLabel ?? t('common.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
