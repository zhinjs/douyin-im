import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AccountStore } from './account-store.js';
import type { StoredAccount } from './types.js';

describe('AccountStore desktop device identity', () => {
  let dataDir = '';

  afterEach(() => {
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('generates and persists one stable renderer device profile for legacy accounts', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-account-'));
    const store = new AccountStore({ dataDir });
    const account: StoredAccount = {
      platformUid: '3138463854771706',
      session: { cookies: 'sessionid=<REDACTED>' },
      deviceProfile: { userAgent: 'test', bizTraceId: 'trace' },
      meta: {
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    };
    store.save(account);

    const profile = store.ensureDeviceProfile(account);
    const saved = JSON.parse(
      readFileSync(join(dataDir, 'accounts', account.platformUid, 'account.json'), 'utf8'),
    ) as StoredAccount;

    expect(profile.deviceId).toBe('0');
    expect(profile.guid).toMatch(/^[0-9a-f]{32}$/);
    expect(profile).toMatchObject({ screenWidth: 1728, screenHeight: 1117 });
    expect(saved.deviceProfile).toEqual(profile);
    expect(store.ensureDeviceProfile(saved)).toEqual(profile);
  });

  it('does not fabricate a registered DID for a newly built profile or replace an existing fallback', () => {
    expect(AccountStore.buildDeviceProfile('agent', 'trace', { guid: 'abc' }).deviceId).toBe('0');
    expect(AccountStore.buildDeviceProfile('agent', 'trace', { guid: 'abc', deviceId: '96354' }).deviceId).toBe('96354');
  });

  it('removes abandoned creator and login-flavor state while loading', () => {
    dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-account-'));
    const store = new AccountStore({ dataDir });
    const account = {
      platformUid: '3138463854771706',
      creatorUserId: 'legacy',
      ticketGuard: { privateKeyPem: 'legacy' },
      session: { cookies: 'sessionid=<REDACTED>' },
      deviceProfile: {
        userAgent: 'test',
        bizTraceId: 'trace',
        loginFlavor: 'jumpbyte-desktop',
      },
      meta: {
        createdAt: '2026-09-02T00:00:00.000Z',
        updatedAt: '2026-09-02T00:00:00.000Z',
      },
    } as unknown as StoredAccount;
    store.save(account);

    const loaded = store.load(account.platformUid) as StoredAccount & Record<string, unknown>;
    const saved = JSON.parse(
      readFileSync(join(dataDir, 'accounts', account.platformUid, 'account.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(loaded['creatorUserId']).toBeUndefined();
    expect(loaded['ticketGuard']).toBeUndefined();
    expect((loaded.deviceProfile as StoredAccount['deviceProfile'] & Record<string, unknown>)['loginFlavor'])
      .toBeUndefined();
    expect(saved['creatorUserId']).toBeUndefined();
    expect(saved['ticketGuard']).toBeUndefined();
  });

  it('never promotes an opaque uid_tt cookie as the platform UID', () => {
    expect(AccountStore.resolveCanonicalUserId({ user_id_str: '1150530166719210' }))
      .toBe('1150530166719210');
    expect(() => AccountStore.resolveCanonicalUserId({ uid_tt: 'opaque-passport-alias' }))
      .toThrow(/numeric user ID/);
  });
});
