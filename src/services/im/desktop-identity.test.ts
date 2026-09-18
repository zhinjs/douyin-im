import { ApiConnection } from '../../desktop/api-connection.js';
import { ImFriendApi } from './friends.js';
import { ImUserDirectory } from './user-directory.js';
import { ImUserSettingsApi } from './user-settings.js';
import { ImEmojiApi } from './emoji.js';
import { ImSharedContent } from './shared-content.js';
import { ImService } from './service.js';
import { ImMediaUploader } from './upload.js';

const operations: [string, (client: ApiConnection) => Promise<unknown>][] = [
  ['friends', client => new ImFriendApi(client, '123', 'fixture-guid').list()],
  ['new-follower-count', client => new ImService(client, { deviceId: '123' }).getNewFollowerCount()],
  ['remark', client => new ImFriendApi(client, '123', 'fixture-guid').setRemark({ uid: '1', secUid: 'fixture-sec', remark: 'fixture' })],
  ['user-batch', client => new ImUserDirectory(client, '123').resolve(['fixture-sec'])],
  ['user-profile', client => new ImUserDirectory(client, '123').getProfile('fixture-sec')],
  ['user-search', client => new ImService(client, { deviceId: '123' }).searchUsers('fixture')],
  ['active-status', client => new ImService(client, { deviceId: '123' }).getActiveStatus(['fixture-sec'], ['456'])],
  ['settings', client => new ImUserSettingsApi(client, '123').getSettings()],
  ['emoji', client => new ImEmojiApi(client, '123', 'fixture-guid').getResources()],
  ['shared-work', client => new ImSharedContent(client, async () => '123').getWorkDetails('456', ['789'])],
  ['video-url', client => new ImService(client, { deviceId: '123' }).resolveVideoUrl('fixture-key')],
  ['upload-credentials', client => new ImMediaUploader(client, async () => '123').uploadFile(Buffer.from('fixture'), 'fixture.txt')],
];

describe('renderer HTTP account identity', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(operations)('%s uses the owning connection in query and HTTP headers', async (_name, run) => {
    const requests: { url: URL; headers: Headers }[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      // Stop at the actual dispatch seam: do not fabricate successful operation results.
      throw new Error('fixture dispatch intercepted');
    });
    for (const id of ['first', 'second', 'first']) {
      const userAgent = `Mozilla/5.0 (${id} synthetic Desktop) fixture/1.2.1`;
      const client = new ApiConnection({ userAgent, deviceId: '123', installId: '456', enableABogus: false });
      const count = requests.length;
      await run(client).catch(() => undefined);
      expect(requests.length).toBe(count + 1);
      const last = requests.at(-1)!;
      expect(last.url.searchParams.get('browser_version')).toBe(userAgent.replace(/^Mozilla\//, ''));
      expect(last.url.searchParams.get('iid')).toBe('456');
      expect(last.headers.get('user-agent')).toBe(userAgent);
    }
  });

  it.each(operations)('%s reads current renderer DID/IID instead of mixing a stale DID with new IID', async (_name, run) => {
    const requests: URL[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      requests.push(new URL(String(input)));
      throw new Error('fixture dispatch intercepted');
    });
    const client = new ApiConnection({ deviceId: '123', installId: '456', enableABogus: false });
    jest.spyOn(client, 'getDeviceId').mockReturnValue('789');
    jest.spyOn(client, 'getInstallId').mockReturnValue('987');
    await run(client).catch(() => undefined);
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]!.searchParams)).toMatchObject({ device_id: '789', did: '789', iid: '987' });
  });

  it('reuses a follow API instance with the current renderer identity and matching verifyFp', async () => {
    const client = new ApiConnection({ deviceId: '123', installId: '456', enableABogus: false });
    jest.spyOn(client, 'hasBoundTicket').mockReturnValue(true);
    const did = jest.spyOn(client, 'getDeviceId');
    const iid = jest.spyOn(client, 'getInstallId');
    const request = jest.spyOn(client, 'requestRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '', rawText: '{"status_code":0,"follow_status":1}',
    });
    const api = new ImFriendApi(client, '123', 'fixture-guid');
    for (const [deviceId, installId] of [['123', '456'], ['789', '987'], ['0', '0']]) {
      did.mockReturnValue(deviceId!); iid.mockReturnValue(installId!);
      await api.setFollowed({ uid: '1', secUid: 'fixture-sec', followed: true });
      const query = new URL(request.mock.calls.at(-1)![0]).searchParams;
      expect(Object.fromEntries(query)).toMatchObject({ device_id: deviceId, did: deviceId, iid: installId, verifyFp: `verify_${deviceId}` });
    }
  });
});
