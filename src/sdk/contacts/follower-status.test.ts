import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '../client.js';
import { Friend } from './friend.js';
import { Stranger } from './stranger.js';
import { Group } from './group.js';
import { Member } from './member.js';
import { createImStateStore } from '../../services/im/state-store.js';
import type { ImUserProfile } from '../../services/im/user-directory.js';

const relation = (contact: Friend | Stranger | Member) => ({
  followStatus: contact.followStatus, followerStatus: contact.followerStatus,
});

describe.each(['memory', 'json', 'sqlite'] as const)('shared follower status: %s', backend => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'douyin-follower-status-'));
    jest.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network'); });
  });
  afterEach(() => {
    expect(globalThis.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function fixture(accountId = '11') {
    const account = new Client({ dataDir: join(directory, 'sdk'), autoLoad: false }).createAccount({ accountId });
    const store = backend === 'memory' ? undefined : createImStateStore({ accountDir: join(directory, accountId), backend });
    const online = jest.spyOn(account, 'online', 'get').mockReturnValue(true);
    const getUserProfile = jest.fn<Promise<ImUserProfile>, [string]>().mockResolvedValue({
      uid: '22', secUid: 'peer', nickname: 'fixture', followStatus: 0, followerStatus: 1,
    });
    const setUserFollowed = jest.fn().mockResolvedValue({ statusCode: 0, followStatus: 2 });
    // Only authentication/runtime startup is omitted; public contact -> Account
    // relation handling and account-scoped persistence are the real production path.
    Object.assign(account, { sender: { imService: { getUserProfile, setUserFollowed } }, stateStore: store });
    const contacts = [Friend.bind('22', '', '', account, { secUid: 'peer' }),
      Stranger.bind('22', '', '', account, { secUid: 'peer' }),
      Member.bind({ uid: '22', secUid: 'peer', role: 2 }, Group.bind('700', '700', account))];
    return { account, store, contacts, getUserProfile, setUserFollowed, online };
  }

  it.each([0, 1, 2])('shares both directions after contact %s reads a profile, without inferring from follow', async index => {
    const f = fixture();
    const other = fixture('33');
    try {
      for (const contact of f.contacts) expect(relation(contact).followerStatus).toBeUndefined();
      const profile = await f.contacts[index]!.getProfile();
      for (const contact of f.contacts) expect(relation(contact)).toEqual({ followStatus: 0, followerStatus: 1 });
      for (const contact of other.contacts) expect(relation(contact).followerStatus).toBeUndefined();
      profile.followerStatus = 0;
      for (const contact of f.contacts) expect(relation(contact).followerStatus).toBe(1);
      f.getUserProfile.mockResolvedValueOnce({ uid: '22', secUid: 'peer', nickname: 'updated', followerStatus: 0 });
      await f.contacts[index]!.getProfile();
      for (const contact of f.contacts) expect(relation(contact)).toEqual({ followStatus: 0, followerStatus: 0 });
      await f.contacts[index]!.setFollowed();
      for (const contact of f.contacts) expect(relation(contact)).toEqual({ followStatus: 2, followerStatus: 0 });
      expect(f.setUserFollowed).toHaveBeenCalledTimes(1);
      expect(f.getUserProfile).toHaveBeenCalledTimes(2); // Follow does not implicitly read back.
      if (backend !== 'memory') {
        const reopened = fixture();
        try { for (const contact of reopened.contacts) expect(relation(contact)).toEqual({ followStatus: 2, followerStatus: 0 }); }
        finally { reopened.store?.close(); }
      }
    } finally { other.store?.close(); f.store?.close(); }
  });

  it('preserves the known direction on missing/invalid profile fields and rejects other identities', async () => {
    const f = fixture();
    try {
      await f.contacts[0]!.getProfile();
      for (const followerStatus of [undefined, -1, 2, 4, NaN, 0.5]) {
        const profile: ImUserProfile = { uid: '22', secUid: 'peer', nickname: 'fixture' };
        if (followerStatus !== undefined) profile.followerStatus = followerStatus;
        f.getUserProfile.mockResolvedValueOnce(profile);
        await f.contacts[1]!.getProfile();
        for (const contact of f.contacts) expect(relation(contact).followerStatus).toBe(1);
      }
      f.getUserProfile.mockResolvedValueOnce({ uid: 'wrong', secUid: 'peer', nickname: 'wrong', followerStatus: 0 });
      await expect(f.contacts[2]!.getProfile()).rejects.toThrow('身份不匹配');
      for (const contact of f.contacts) expect(relation(contact).followerStatus).toBe(1);
    } finally { f.store?.close(); }
  });

  it('does not publish a stale profile over a newer relationship or into an offline account', async () => {
    const f = fixture();
    try {
      await f.contacts[0]!.getProfile();
      let resolve!: (value: ImUserProfile) => void;
      f.getUserProfile.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const pending = f.contacts[1]!.getProfile();
      f.account.updateUserRelation('22', { followStatus: 4 });
      resolve({ uid: '22', secUid: 'peer', nickname: 'stale', followStatus: 0, followerStatus: 0 });
      await pending;
      for (const contact of f.contacts) expect(relation(contact)).toEqual({ followStatus: 4, followerStatus: 1 });
      f.getUserProfile.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
      const late = f.contacts[2]!.getProfile();
      f.online.mockReturnValue(false);
      resolve({ uid: '22', secUid: 'peer', nickname: 'late', followerStatus: 0 });
      await expect(late).rejects.toThrow('账号状态已变化');
      for (const contact of f.contacts) expect(relation(contact).followerStatus).toBe(1);
    } finally { f.store?.close(); }
  });
});
