import { Plus, Star, Trash2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useT } from '../i18n';
import { useVault } from '../hooks/VaultContext';
import {
  CARD_FIELDS,
  CARD_PROTECTED,
  IDENTITY_FIELDS,
  IDENTITY_PROTECTED,
  cx,
  normalizeUrl,
  structuredFieldNames,
} from '../lib/utils';
import type { Field, Folder, Item } from '../types';
import { errorMessage } from '../types';
import { PasswordGenerator } from './PasswordGenerator';
import { PasswordStrength } from './PasswordStrength';
import { Button, ErrorText, FieldLabel, Group, IconButton, Input, PasswordInput, SectionTitle, Select, Switch, Textarea } from './ui';

interface ItemEditorProps {
  initial: Item;
  onSave: (item: Item) => Promise<void>;
  onCancel: () => void;
}

type Draft = Omit<Item, 'fields'> & { structured: Record<string, string>; custom: Field[] };

function toDraft(item: Item): Draft {
  const names = new Set(structuredFieldNames(item.kind));
  const structured: Record<string, string> = {};
  const custom: Field[] = [];
  for (const f of item.fields) {
    if (names.has(f.name)) structured[f.name] = f.value;
    else custom.push({ ...f });
  }
  const { fields: _f, ...rest } = item;
  return { ...rest, urls: item.urls.length ? [...item.urls] : item.kind === 'login' ? [''] : [], structured, custom };
}

function fromDraft(d: Draft): Item {
  const { structured, custom, ...rest } = d;
  const protectedSet = d.kind === 'card' ? CARD_PROTECTED : d.kind === 'identity' ? IDENTITY_PROTECTED : new Set<string>();
  const fields: Field[] = [];
  for (const name of structuredFieldNames(d.kind)) {
    const value = (structured[name] ?? '').trim();
    if (value) fields.push({ name, value, protected: protectedSet.has(name) });
  }
  for (const f of custom) {
    if (f.name.trim() || f.value) fields.push({ name: f.name.trim(), value: f.value, protected: f.protected });
  }
  return {
    ...rest,
    title: rest.title.trim(),
    urls: rest.urls.map((u) => normalizeUrl(u)).filter(Boolean),
    totp: rest.totp && rest.totp.trim() ? rest.totp.trim() : null,
    fields,
  };
}

export function ItemEditor({ initial, onSave, onCancel }: ItemEditorProps) {
  const t = useT();
  const { folders } = useVault();
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [genOpen, setGenOpen] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const isNew = !initial.id;

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((prev) => ({ ...prev, [k]: v }));
  const setS = (name: string, v: string) => setD((prev) => ({ ...prev, structured: { ...prev.structured, [name]: v } }));

  const folderOptions = useMemo(() => flattenFolders(folders), [folders]);

  const submit = async () => {
    if (!d.title.trim()) {
      setError(t('editor.titleRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      await onSave(fromDraft(d));
    } catch (e) {
      setError(errorMessage(e));
      setSaving(false);
    }
  };

  const kindLabel = t(`kind.${d.kind}`);
  const updCustom = (i: number, patch: Partial<Field>) =>
    set('custom', d.custom.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <form
      className="flex h-full flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit();
        if (e.key === 'Escape' && !genOpen) onCancel();
      }}
    >
      <div data-tauri-drag-region className="flex h-toolbar shrink-0 items-center justify-between gap-2 pr-4 pl-6">
        <span className="truncate text-[12px] font-medium text-muted">
          {isNew ? t('editor.newTitle', { kind: kindLabel }) : t('editor.editTitle', { kind: kindLabel })}
        </span>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="subtle" pill onClick={onCancel} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" variant="primary" pill type="submit" loading={saving} className="px-4">
            {saving ? t('editor.saving') : t('common.save')}
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto max-w-[640px] space-y-5 pt-1">
          <div className="flex items-center gap-2">
            <Input
              value={d.title}
              onChange={(e) => set('title', e.target.value)}
              autoFocus
              spellCheck={false}
              placeholder={t('common.title')}
              aria-label={t('common.title')}
              className="h-11 rounded-xl px-4 text-[17px] font-semibold tracking-[-0.01em]"
            />
            <IconButton
              label={t('editor.favorite')}
              className="h-11 w-11 rounded-xl bg-surface-2 hover:bg-surface-3"
              onClick={() => set('favorite', !d.favorite)}
            >
              <Star size={17} fill={d.favorite ? 'currentColor' : 'none'} className={d.favorite ? 'text-warning' : undefined} />
            </IconButton>
          </div>
          {error && <div className="-mt-4"><ErrorText>{error}</ErrorText></div>}

          {d.kind === 'login' && (
            <>
              <Group>
                <EditRow label={t('common.username')}>
                  <Input inset value={d.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" spellCheck={false} />
                </EditRow>
                <EditRow label={t('common.password')}>
                  <div className="relative flex gap-1.5">
                    <PasswordInput
                      inset
                      className="flex-1"
                      value={d.password}
                      revealed={showPw}
                      onRevealChange={setShowPw}
                      onChange={(e) => set('password', e.target.value)}
                    />
                    <Button type="button" variant="tonal" icon={<Wand2 size={13} />} onClick={() => setGenOpen(true)} title={t('gen.open')}>
                      {t('gen.open')}
                    </Button>
                    {genOpen && (
                      <PasswordGenerator
                        onClose={() => setGenOpen(false)}
                        onUse={(pw) => {
                          set('password', pw);
                          setShowPw(true);
                          setGenOpen(false);
                        }}
                      />
                    )}
                  </div>
                  <PasswordStrength password={d.password} />
                </EditRow>
                <EditRow label={t('editor.totp')} hint={t('common.optional')}>
                  <Input
                    inset
                    value={d.totp ?? ''}
                    onChange={(e) => set('totp', e.target.value)}
                    placeholder="otpauth://totp/… or JBSWY3DPEHPK3PXP"
                    className="font-mono text-[12px]"
                    spellCheck={false}
                  />
                </EditRow>
              </Group>

              <section>
                <SectionTitle
                  className="px-1"
                  action={
                    <Button size="sm" variant="link" pill icon={<Plus size={12} />} className="h-6 px-2" onClick={() => set('urls', [...d.urls, ''])}>
                      {t('editor.addUrl')}
                    </Button>
                  }
                >
                  {t('detail.urls')}
                </SectionTitle>
                {d.urls.length > 0 && (
                  <Group>
                    {d.urls.map((u, i) => (
                      <div key={i} className="group flex items-center gap-1.5 px-3 py-2">
                        <Input
                          inset
                          value={u}
                          placeholder={i === 0 ? 'https://example.com/login' : t('editor.url')}
                          onChange={(e) => set('urls', d.urls.map((x, j) => (j === i ? e.target.value : x)))}
                          spellCheck={false}
                        />
                        <IconButton
                          label={t('common.remove')}
                          className="hover:text-danger"
                          onClick={() => set('urls', d.urls.filter((_, j) => j !== i))}
                        >
                          <Trash2 size={14} />
                        </IconButton>
                      </div>
                    ))}
                  </Group>
                )}
              </section>
            </>
          )}

          {d.kind === 'card' && (
            <Group>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-3.5">
                {CARD_FIELDS.map((name) => {
                  const label = t(`card.${name}` as const);
                  const wide = name === 'cardholderName' || name === 'number';
                  return (
                    <div key={name} className={cx(wide && 'col-span-2')}>
                      <FieldLabel className="text-[11px]">{label}</FieldLabel>
                      {CARD_PROTECTED.has(name) ? (
                        <PasswordInput inset value={d.structured[name] ?? ''} onChange={(e) => setS(name, e.target.value)} />
                      ) : (
                        <Input
                          inset
                          value={d.structured[name] ?? ''}
                          onChange={(e) => setS(name, e.target.value)}
                          placeholder={name === 'expMonth' ? 'MM' : name === 'expYear' ? 'YYYY' : undefined}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            </Group>
          )}

          {d.kind === 'identity' && (
            <Group>
              <div className="grid grid-cols-2 gap-x-3 gap-y-3 px-4 py-3.5">
                {IDENTITY_FIELDS.map((name) => {
                  const label = t(`identity.${name}` as const);
                  const wide = name.startsWith('address') || name === 'email' || name === 'company';
                  return (
                    <div key={name} className={cx(wide && 'col-span-2')}>
                      <FieldLabel className="text-[11px]">{label}</FieldLabel>
                      {IDENTITY_PROTECTED.has(name) ? (
                        <PasswordInput inset value={d.structured[name] ?? ''} onChange={(e) => setS(name, e.target.value)} />
                      ) : (
                        <Input inset value={d.structured[name] ?? ''} onChange={(e) => setS(name, e.target.value)} />
                      )}
                    </div>
                  );
                })}
                <div className="col-span-2">
                  <FieldLabel className="text-[11px]">{t('common.username')}</FieldLabel>
                  <Input inset value={d.username} onChange={(e) => set('username', e.target.value)} />
                </div>
              </div>
            </Group>
          )}

          <section>
            <SectionTitle className="px-1">{t('common.notes')}</SectionTitle>
            <Textarea value={d.notes} onChange={(e) => set('notes', e.target.value)} rows={d.kind === 'note' ? 10 : 3} className="rounded-xl px-4 py-3" />
          </section>

          <section>
            <SectionTitle
              className="px-1"
              action={
                <Button
                  size="sm"
                  variant="link"
                  pill
                  icon={<Plus size={12} />}
                  className="h-6 px-2"
                  onClick={() => set('custom', [...d.custom, { name: '', value: '', protected: false }])}
                >
                  {t('editor.addField')}
                </Button>
              }
            >
              {t('editor.customFields')}
            </SectionTitle>
            {d.custom.length > 0 && (
              <Group>
                {d.custom.map((f, i) => (
                  <div key={i} className="flex items-center gap-1.5 px-3 py-2">
                    <Input inset value={f.name} placeholder={t('editor.fieldName')} className="w-2/5" onChange={(e) => updCustom(i, { name: e.target.value })} />
                    {f.protected ? (
                      <PasswordInput inset className="flex-1" value={f.value} placeholder={t('editor.fieldValue')} onChange={(e) => updCustom(i, { value: e.target.value })} />
                    ) : (
                      <Input inset className="flex-1" value={f.value} placeholder={t('editor.fieldValue')} onChange={(e) => updCustom(i, { value: e.target.value })} />
                    )}
                    <label className="flex shrink-0 cursor-default items-center gap-1.5 pl-1 text-[11px] text-muted" title={t('editor.fieldHidden')}>
                      <Switch checked={f.protected} onChange={(v) => updCustom(i, { protected: v })} label={t('editor.fieldHidden')} />
                      {t('editor.fieldHidden')}
                    </label>
                    <IconButton label={t('common.remove')} className="hover:text-danger" onClick={() => set('custom', d.custom.filter((_, j) => j !== i))}>
                      <Trash2 size={14} />
                    </IconButton>
                  </div>
                ))}
              </Group>
            )}
          </section>

          <Group>
            <EditRow label={t('common.folder')}>
              <Select inset value={d.folder ?? ''} onChange={(e) => set('folder', e.target.value || null)}>
                <option value="">{t('common.root')}</option>
                {folderOptions.map((f) => (
                  <option key={f.id} value={f.id}>
                    {'\u00a0\u00a0'.repeat(f.depth) + f.name}
                  </option>
                ))}
              </Select>
            </EditRow>
          </Group>
        </div>
      </div>
    </form>
  );
}

/** Label above a full-width control, inside a Group. */
function EditRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <FieldLabel className="mb-1.5 text-[11px]" hint={hint}>
        {label}
      </FieldLabel>
      {children}
    </div>
  );
}

function flattenFolders(folders: Folder[], parent: string | null = null, depth = 0): (Folder & { depth: number })[] {
  return folders
    .filter((f) => f.parent === parent)
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((f) => [{ ...f, depth }, ...flattenFolders(folders, f.id, depth + 1)]);
}
