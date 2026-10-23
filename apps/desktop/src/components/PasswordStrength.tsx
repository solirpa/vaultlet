import { useT } from '../i18n';
import { cx, passwordStrength } from '../lib/utils';

const colors = ['bg-danger', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];

export function PasswordStrength({ password }: { password: string }) {
  const t = useT();
  const score = passwordStrength(password);
  const key = (['strength.0', 'strength.1', 'strength.2', 'strength.3', 'strength.4'] as const)[score];
  return (
    <div className="mt-1.5 flex items-center gap-2">
      <div className="flex flex-1 gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className={cx('h-1 flex-1 rounded-full', password && i < Math.max(1, score) ? colors[score] : 'bg-surface-3')}
          />
        ))}
      </div>
      <span className="w-16 text-right text-[11px] text-muted">{password ? t(key) : ''}</span>
    </div>
  );
}
