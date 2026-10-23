/**
 * Decide whether a captured login should be offered for saving, offered as a
 * password update, or ignored. Pure so it can be unit-tested.
 */
import type { LoginEntry } from './protocol';

export interface CapturedLogin {
  username: string;
  password: string;
}

export type SaveDecision =
  | { kind: 'none' }
  | { kind: 'save' }
  | { kind: 'update'; entryId: string; username: string };

/** Usernames are compared trimmed and case-insensitively (emails are case-insensitive in practice). */
export function sameUsername(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * `entries` are the app's `get-logins` result for the capture's URL, best match first.
 *
 *  - empty password                               → none
 *  - an entry with the same username + password    → none
 *  - no username captured, password already stored → none (password-only re-auth forms)
 *  - same username, different password             → update (first such entry)
 *  - otherwise                                     → save
 */
export function decideSaveOffer(capture: CapturedLogin, entries: Pick<LoginEntry, 'id' | 'username' | 'password'>[]): SaveDecision {
  if (!capture.password) return { kind: 'none' };
  const sameUser = entries.filter((e) => sameUsername(e.username ?? '', capture.username));
  if (sameUser.some((e) => e.password === capture.password)) return { kind: 'none' };
  if (!capture.username.trim() && entries.some((e) => e.password === capture.password)) return { kind: 'none' };
  const target = sameUser[0];
  if (target) return { kind: 'update', entryId: target.id, username: target.username };
  return { kind: 'save' };
}
