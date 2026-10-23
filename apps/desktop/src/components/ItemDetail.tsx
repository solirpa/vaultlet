import {
  ArchiveRestore,
  Copy,
  CreditCard,
  ExternalLink,
  Eye,
  EyeOff,
  FolderIcon,
  KeyRound,
  Pencil,
  Star,
  StickyNote,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { useCopy } from '../hooks/useCopy';
import { useVault } from '../hooks/VaultContext';
import { openExternal } from '../lib/platform';
import {
  CARD_FIELDS,
  IDENTITY_FIELDS,
  cx,
  fieldValue,
  formatDateTime,
  hostOf,
  normalizeUrl,
  structuredFieldNames,
} from '../lib/utils';
import { SiteIcon } from './SiteIcon';
import type { Item, ItemKind } from '../types';
import { TotpRing } from './TotpRing';
import { Button, Group, GroupRow, IconButton, SectionTitle } from './ui';

interface ItemDetailProps {
  item: Item;
  onEdit: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onPurge: () => void;
  onToggleFavorite: () => void;
  onTouch: () => void;
}

const kindIcon: Record<ItemKind, ReactNode> = {
  login: <KeyRound size={12} />,
  note: <StickyNote size={12} />,
  card: <CreditCard size={12} />,
  identity: <UserRound size={12} />,
};

export function ItemDetail({ item, onEdit, onDelete, onRestore, onPurge, onToggleFavorite, onTouch }: ItemDetailProps) {
  const { t, lang } = useI18n();
  const { folders } = useVault();
  const copy = useCopy();
  const folderName = item.folder ? folders.find((f) => f.id === item.folder)?.name : null;
  const structured = new Set(structuredFieldNames(item.kind));
  const customFields = item.fields.filter((f) => !structured.has(f.name));
  const urls = item.urls.filter(Boolean);

  const copyAndTouch = (v: string, label: string) => {
    copy(v, label);
    onTouch();
  };

  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="flex h-toolbar shrink-0 items-center justify-end gap-1 px-4">
        {item.deleted ? (
          <>
            <Button size="sm" icon={<ArchiveRestore size={13} />} onClick={onRestore}>
              {t('detail.restore')}
            </Button>
            <Button size="sm" variant="danger" icon={<Trash2 size={13} />} onClick={onPurge}>
              {t('detail.purge')}
            </Button>
          </>
        ) : (
          <>
            <IconButton
              label={item.favorite ? t('detail.unfavorite') : t('detail.favorite')}
              onClick={onToggleFavorite}
            >
              <Star size={16} fill={item.favorite ? 'currentColor' : 'none'} className={item.favorite ? 'text-warning' : undefined} />
            </IconButton>
            <IconButton label={t('common.delete')} onClick={onDelete} className="hover:text-danger">
              <Trash2 size={16} />
            </IconButton>
            <Button size="sm" variant="primary" pill icon={<Pencil size={12} />} onClick={onEdit} className="ml-1 px-3.5">
              {t('common.edit')}
            </Button>
          </>
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        <div className="mx-auto max-w-[640px]">
          <header className="flex items-center gap-3 pt-1 pb-4">
            <SiteIcon title={item.title} url={item.urls[0]} kind={item.kind} size={40} />
            <div className="min-w-0">
              <h1 className="selectable truncate text-[17px] leading-tight font-semibold tracking-[-0.015em]">{item.title || '—'}</h1>
              <div className="mt-1 flex items-center gap-2.5 text-[11.5px] text-muted">
                <span className="inline-flex items-center gap-1">
                  {kindIcon[item.kind]} {t(`kind.${item.kind}`)}
                </span>
                {folderName && (
                  <span className="inline-flex min-w-0 items-center gap-1">
                    <FolderIcon size={12} className="shrink-0" />
                    <span className="truncate">{folderName}</span>
                  </span>
                )}
              </div>
            </div>
          </header>

          {item.deleted && (
            <div className="mb-5 rounded-xl bg-warning-soft px-4 py-2.5 text-xs text-text">{t('detail.inTrash')}</div>
          )}

          <div className="space-y-5">
            {item.kind === 'login' && (item.username || item.password || item.totp) && (
              <Group>
                {item.username && (
                  <Row label={t('common.username')} value={item.username} onCopy={() => copyAndTouch(item.username, t('common.username'))} />
                )}
                {item.password && (
                  <SecretRow label={t('common.password')} value={item.password} onCopy={() => copyAndTouch(item.password, t('common.password'))} mono />
                )}
                {item.totp && <TotpRow itemId={item.id} onCopy={(c) => copyAndTouch(c, t('detail.totp'))} />}
              </Group>
            )}

            {item.kind === 'card' && (
              <Group>
                {CARD_FIELDS.map((name) => {
                  const v = fieldValue(item, name);
                  if (!v) return null;
                  const label = t(`card.${name}` as const);
                  const f = item.fields.find((x) => x.name === name);
                  return f?.protected ? (
                    <SecretRow key={name} label={label} value={v} mono onCopy={() => copyAndTouch(v, label)} />
                  ) : (
                    <Row key={name} label={label} value={v} onCopy={() => copyAndTouch(v, label)} />
                  );
                })}
              </Group>
            )}

            {item.kind === 'identity' && (
              <Group>
                {IDENTITY_FIELDS.map((name) => {
                  const v = fieldValue(item, name);
                  if (!v) return null;
                  const label = t(`identity.${name}` as const);
                  const f = item.fields.find((x) => x.name === name);
                  return f?.protected ? (
                    <SecretRow key={name} label={label} value={v} onCopy={() => copyAndTouch(v, label)} />
                  ) : (
                    <Row key={name} label={label} value={v} onCopy={() => copyAndTouch(v, label)} />
                  );
                })}
                {item.username && (
                  <Row label={t('common.username')} value={item.username} onCopy={() => copyAndTouch(item.username, t('common.username'))} />
                )}
              </Group>
            )}

            {urls.length > 0 && (
              <section>
                <SectionTitle className="px-1">{t('detail.urls')}</SectionTitle>
                <Group>
                  {urls.map((u, i) => (
                    <GroupRow
                      key={i}
                      className="min-h-[42px] py-2"
                      actions={
                        <>
                          <IconButton label={t('detail.openUrl')} size="sm" className="reveal" onClick={() => openExternal(normalizeUrl(u))}>
                            <ExternalLink size={13} />
                          </IconButton>
                          <IconButton label={t('common.copy')} size="sm" className="reveal" onClick={() => copy(u)}>
                            <Copy size={13} />
                          </IconButton>
                        </>
                      }
                    >
                      <button
                        type="button"
                        className="selectable block max-w-full truncate text-left text-[13px] hover:underline"
                        title={u}
                        onClick={() => {
                          openExternal(normalizeUrl(u));
                          onTouch();
                        }}
                      >
                        <span className="text-accent">{hostOf(u)}</span>
                        <span className="text-faint">{u.replace(/^https?:\/\/[^/]+/, '') || ''}</span>
                      </button>
                    </GroupRow>
                  ))}
                </Group>
              </section>
            )}

            {item.notes && (
              <section>
                <SectionTitle className="px-1">{t('common.notes')}</SectionTitle>
                <Group>
                  <GroupRow
                    align="start"
                    actions={
                      <IconButton label={t('common.copy')} size="sm" className="reveal -mt-0.5" onClick={() => copy(item.notes)}>
                        <Copy size={13} />
                      </IconButton>
                    }
                  >
                    <pre className="selectable font-sans text-[13px] leading-relaxed whitespace-pre-wrap">{item.notes}</pre>
                  </GroupRow>
                </Group>
              </section>
            )}

            {customFields.length > 0 && (
              <section>
                <SectionTitle className="px-1">{t('detail.customFields')}</SectionTitle>
                <Group>
                  {customFields.map((f, i) =>
                    f.protected ? (
                      <SecretRow key={i} label={f.name} value={f.value} onCopy={() => copy(f.value, f.name)} />
                    ) : (
                      <Row key={i} label={f.name} value={f.value} onCopy={() => copy(f.value, f.name)} />
                    ),
                  )}
                </Group>
              </section>
            )}

            {item.tags.length > 0 && (
              <section>
                <SectionTitle className="px-1">{t('detail.tags')}</SectionTitle>
                <div className="flex flex-wrap gap-1.5 px-1">
                  {item.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[11.5px] text-muted">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            )}

            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-1 pt-1 text-[11px] text-faint tabular-nums">
              <dt>{t('detail.created')}</dt>
              <dd>{formatDateTime(item.created, lang)}</dd>
              <dt>{t('detail.modified')}</dt>
              <dd>{formatDateTime(item.modified, lang)}</dd>
              <dt>{t('detail.lastUsed')}</dt>
              <dd>{formatDateTime(item.lastUsed, lang)}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, onCopy, mono }: { label: string; value: string; onCopy: () => void; mono?: boolean }) {
  const { t } = useI18n();
  return (
    <GroupRow
      label={label}
      actions={
        <IconButton label={t('common.copy')} size="sm" className="reveal" onClick={onCopy}>
          <Copy size={13} />
        </IconButton>
      }
    >
      <div className={cx('selectable truncate text-[13px]', mono && 'font-mono')}>{value}</div>
    </GroupRow>
  );
}

function SecretRow({ label, value, onCopy, mono }: { label: string; value: string; onCopy: () => void; mono?: boolean }) {
  const { t } = useI18n();
  const [shown, setShown] = useState(false);
  return (
    <GroupRow
      label={label}
      actions={
        <>
          <IconButton
            label={shown ? t('common.hide') : t('common.show')}
            size="sm"
            className="reveal"
            data-force={shown ? '' : undefined}
            onClick={() => setShown(!shown)}
          >
            {shown ? <EyeOff size={13} /> : <Eye size={13} />}
          </IconButton>
          <IconButton label={t('common.copy')} size="sm" className="reveal" onClick={onCopy}>
            <Copy size={13} />
          </IconButton>
        </>
      }
    >
      <div className={cx('selectable truncate text-[13px]', (mono || !shown) && 'font-mono', !shown && 'tracking-[0.12em] text-muted')}>
        {shown ? value : '•'.repeat(Math.min(16, Math.max(8, value.length)))}
      </div>
    </GroupRow>
  );
}

function TotpRow({ itemId, onCopy }: { itemId: string; onCopy: (code: string) => void }) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  return (
    <GroupRow
      label={t('detail.totp')}
      actions={
        <IconButton label={t('common.copy')} size="sm" className="reveal" disabled={!code} onClick={() => onCopy(code)}>
          <Copy size={13} />
        </IconButton>
      }
    >
      <TotpRing itemId={itemId} onCode={setCode} />
    </GroupRow>
  );
}
