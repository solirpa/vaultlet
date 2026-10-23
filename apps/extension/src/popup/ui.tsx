export function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-1 flex-col items-center justify-center gap-1.5 pb-8 text-text">{children}</div>;
}

export function StateIcon({ children, accent }: { children: React.ReactNode; accent?: boolean }) {
  return (
    <div
      className={`mb-1 flex h-11 w-11 items-center justify-center rounded-full ${accent ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted'}`}
    >
      {children}
    </div>
  );
}

/** Title shown for an entry everywhere in the popup. */
export function entryTitle(e: { title: string; username: string; url: string }, host: string): string {
  return e.title || host || e.username || 'Login';
}
