import type { ReactNode } from 'react';
import { cx } from '../lib/utils';

/**
 * Centered column shared by unlock / first-run / create screens: a logo mark
 * and heading sit above a soft floating card; quiet actions go below it.
 */
export function AuthShell({
  children,
  width = 'max-w-[380px]',
  header,
  footer,
  toolbar,
}: {
  children: ReactNode;
  width?: string;
  header?: ReactNode;
  footer?: ReactNode;
  /** Controls shown in the title-bar strip, right of the traffic lights. */
  toolbar?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-bg">
      <div data-tauri-drag-region className="flex h-toolbar shrink-0 items-center pl-[96px]">
        {toolbar}
      </div>
      <div className="flex flex-1 overflow-y-auto px-6 pb-toolbar">
        <div className={cx('m-auto flex w-full flex-col items-center py-6', width)}>
          {header && <div className="mb-6 flex flex-col items-center text-center">{header}</div>}
          <div className="w-full rounded-3xl bg-surface p-6 shadow-card">{children}</div>
          {footer && <div className="mt-4 w-full">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

export function VaultLogo({ size = 48 }: { size?: number }) {
  return (
    <div
      className="flex items-center justify-center text-accent-fg"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: 'linear-gradient(160deg, color-mix(in srgb, var(--c-accent) 80%, white) 0%, var(--c-accent) 60%, color-mix(in srgb, var(--c-accent) 80%, black) 100%)',
        boxShadow: '0 6px 18px color-mix(in srgb, var(--c-accent) 35%, transparent), inset 0 1px 0 rgba(255,255,255,0.25)',
      }}
    >
      <svg
        width={size * 0.52}
        height={size * 0.52}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="9" cy="9" r="4.6" />
        <path d="M12.3 12.3 19.5 19.5M16.4 16.4l-2 2M19 19l-2 2" />
      </svg>
    </div>
  );
}
