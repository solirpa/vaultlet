import { describe, expect, it } from 'vitest';
import { decideSaveOffer } from '../shared/save-decision';

const e = (id: string, username: string, password: string) => ({ id, username, password });

describe('decideSaveOffer', () => {
  it('does nothing when the same username + password is already stored', () => {
    expect(decideSaveOffer({ username: 'alice', password: 'pw' }, [e('1', 'alice', 'pw')])).toEqual({ kind: 'none' });
  });

  it('compares usernames trimmed and case-insensitively', () => {
    expect(decideSaveOffer({ username: ' Alice@Example.com', password: 'pw' }, [e('1', 'alice@example.com', 'pw')])).toEqual({
      kind: 'none',
    });
  });

  it('offers an update when the username exists with a different password', () => {
    expect(decideSaveOffer({ username: 'ALICE', password: 'new' }, [e('9', 'bob', 'x'), e('1', 'alice', 'old')])).toEqual({
      kind: 'update',
      entryId: '1',
      username: 'alice',
    });
  });

  it('updates the best (first) match when several logins share the username', () => {
    expect(decideSaveOffer({ username: 'alice', password: 'new' }, [e('1', 'alice', 'a'), e('2', 'alice', 'b')])).toMatchObject({
      kind: 'update',
      entryId: '1',
    });
  });

  it('does nothing when any login with that username already has this password', () => {
    expect(decideSaveOffer({ username: 'alice', password: 'b' }, [e('1', 'alice', 'a'), e('2', 'alice', 'b')])).toEqual({
      kind: 'none',
    });
  });

  it('offers to save a new username or a site without logins', () => {
    expect(decideSaveOffer({ username: 'carol', password: 'pw' }, [e('1', 'alice', 'pw')])).toEqual({ kind: 'save' });
    expect(decideSaveOffer({ username: 'carol', password: 'pw' }, [])).toEqual({ kind: 'save' });
  });

  it('handles password-only forms (no username captured)', () => {
    // re-auth prompt with a stored password → nothing to do
    expect(decideSaveOffer({ username: '', password: 'pw' }, [e('1', 'alice', 'pw')])).toEqual({ kind: 'none' });
    // unknown password and no username → offer a new login rather than overwrite one
    expect(decideSaveOffer({ username: '', password: 'other' }, [e('1', 'alice', 'pw')])).toEqual({ kind: 'save' });
    // a stored login without username and a different password → update it
    expect(decideSaveOffer({ username: '', password: 'other' }, [e('1', '', 'pw')])).toEqual({
      kind: 'update',
      entryId: '1',
      username: '',
    });
  });

  it('never offers anything for an empty password', () => {
    expect(decideSaveOffer({ username: 'alice', password: '' }, [])).toEqual({ kind: 'none' });
  });
});
