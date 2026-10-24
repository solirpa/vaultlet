/**
 * Content script (isolated world, document_start, every frame): relays passkey
 * requests from the page script to the background and the answers back.
 * The background takes the origin from this frame's sender information.
 */
import { rpc } from '../shared/rpc';
import {
  PAGE_CHANNEL,
  isPageMessage,
  type PageCreateRequest,
  type PageCreateResult,
  type PageGetRequest,
  type PageGetResult,
  type PageMessage,
} from '../shared/webauthn';

const reply = (id: string, result: PageGetResult | PageCreateResult) =>
  window.postMessage({ source: PAGE_CHANNEL, id, dir: 'response', result } satisfies PageMessage, window.location.origin);

window.addEventListener('message', (ev) => {
  if (ev.source !== window || !isPageMessage(ev.data)) return;
  const { id, dir, op, request } = ev.data;
  if (dir === 'cancel') {
    rpc('passkeyCancel', id).catch(() => {});
    return;
  }
  if (dir !== 'request' || !request) return;
  const call =
    op === 'create'
      ? rpc('passkeyCreate', id, request as PageCreateRequest)
      : rpc('passkeyGet', id, request as PageGetRequest);
  call.then((result) => reply(id, result)).catch(() => reply(id, { kind: 'fallback' }));
});
