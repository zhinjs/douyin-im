import { ImEmojiApi, type CollectEmojiOptions } from './emoji.js';
import type { ImHttpClient } from './service.js';
import { ActionChallengeError } from '../../http/action-challenge.js';

function fixture(body: unknown, headers = new Headers()) {
  const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers,
    data: '', rawText: typeof body === 'string' ? body : JSON.stringify(body) });
  const api = new ImEmojiApi({ requestRaw, getUserAgent: () => 'fixture-UA', getInstallId: () => 'iid' } as unknown as ImHttpClient,
    'did', 'guid', { width: 900, height: 600 });
  return { api, requestRaw };
}

const message: CollectEmojiOptions = {
  imageId: '7600000000000000123', stickerUri: 'tos-cn-sticker/item',
  stickerUrl: 'https://example.invalid/a.webp?x=1&y=2', resourceId: '0', stickerType: 1,
};

describe('Desktop emoji resource and collection contracts', () => {
  it('returns an archive descriptor from the root, not an emoji array or a download', async () => {
    const { api, requestRaw } = fixture({ android_emoji_resource: { resource_url: 'https://example.invalid/emojis.zip', md5: 'version' }, android_emoji_status: 0 });
    await expect(api.getResources()).resolves.toEqual({ statusCode: 0, statusMsg: '',
      androidResource: { url: 'https://example.invalid/emojis.zip', md5: 'version' }, androidResourceStatus: 0 });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    const url = new URL(input);
    expect(url.origin).toBe('https://imdesktop.douyin.com');
    expect(url.pathname).toBe('/aweme/v1/web/im/resources/emoji/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ aid: '339757', iid: 'iid', did: 'did',
      device_id: 'did', awemeim_guid: 'guid', screen_width: '900', screen_height: '600' });
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.bgint_json_parser).toBe('2');
    expect(passport).toBe(false);
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('preserves the explicit fallback status without manufacturing a resource', async () => {
    const { api } = fixture({ android_emoji_resource: {}, android_emoji_status: 1 });
    await expect(api.getResources()).resolves.toEqual({ statusCode: 0, statusMsg: '', androidResourceStatus: 1 });
  });

  it.each([{}, { status_code: 0 }, { android_emoji_status: 1 },
    { android_emoji_resource: { resource_url: 'url' } }, { data: { android_emoji_resource: { resource_url: 'url', md5: 'version' } } },
    { android_emoji_resource: { resource_url: '', md5: '' } }])('does not invent a valid manifest for %j', async body => {
    await expect(fixture(body).api.getResources()).resolves.toMatchObject({ statusCode: -3 });
  });

  it.each([0, 200])('collects with null-equivalent POST body and query, accepting source status %i', async status => {
    const { api, requestRaw } = fixture(`{"status_code":${status},"success_items":[{"id":7600000000000000123,"width":120,"unknown":true}]}`);
    await expect(api.collect(message)).resolves.toEqual({ statusCode: 0, statusMsg: '',
      successItems: [{ id: '7600000000000000123', width: 120, unknown: true }] });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    const url = new URL(input);
    expect(url.pathname).toBe('/aweme/v1/web/im/resources/sticker/collect/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ action: '1', sticker_ids: '[7600000000000000123]',
      sticker_uri: message.stickerUri, sticker_url: message.stickerUrl, resource_id: '0', sticker_type: '1' });
    expect(init.method).toBe('POST');
    expect(init.body).toBe('');
    expect(init.headers.bgint_json_parser).toBe('2');
    expect(passport).toBe(false);
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('preserves ID-only type 0 and omitted URI-based ID/package without inventing defaults', async () => {
    const { api, requestRaw } = fixture({ status_code: 0, success_items: [{ id: '1' }] });
    await api.collect({ imageId: '1', stickerUri: '', stickerUrl: '', resourceId: '0', stickerType: 0 });
    await api.collect({ stickerUri: 'uri', stickerUrl: 'url', stickerType: 3 });
    const first = new URL(requestRaw.mock.calls[0]![0]);
    const second = new URL(requestRaw.mock.calls[1]![0]);
    expect(first.searchParams.get('sticker_type')).toBe('0');
    expect(first.searchParams.get('sticker_uri')).toBe('');
    expect(second.searchParams.get('sticker_ids')).toBe('[]');
    expect(second.searchParams.has('resource_id')).toBe(false);
    await api.collect({ imageId: '3', resourceId: '0', stickerType: 3 });
    const search = new URL(requestRaw.mock.calls[2]![0]);
    expect(search.searchParams.has('sticker_uri')).toBe(false);
    expect(search.searchParams.has('sticker_url')).toBe(false);
  });

  it.each([{}, { status_code: 0 }, { status_code: 0, success_items: [] }, { status_code: 0, success_items: [{}] },
    { status_code: 0, success_items: '[{"id":1}]' }, { status_code: 0, success_items: [null] },
    { status_code: '0', success_items: [{ id: '1' }] }])('rejects apparent collection success without confirmed records: %j', async body => {
    await expect(fixture(body).api.collect(message)).resolves.toMatchObject({ statusCode: -3, successItems: [] });
  });

  it.each([7279, 7280, 7281, 8])('preserves server refusal %i without retry or success records', async code => {
    const { api, requestRaw } = fixture({ status_code: code, status_msg: 'refused', success_items: [{ id: '1' }] });
    await expect(api.collect(message)).resolves.toEqual({ statusCode: code, statusMsg: 'refused', successItems: [] });
    await expect(api.getResources()).resolves.toEqual({ statusCode: code, statusMsg: 'refused' });
    expect(requestRaw).toHaveBeenCalledTimes(2);
  });

  it.each([{ imageId: '1,2' }, { imageId: '1e3' }, { imageId: '' }, { imageId: Number('7600000000000000123') },
    { resourceId: '-1' }, { stickerType: -1 }, { stickerType: 1.5 }, { stickerUrl: null }])('rejects invalid inputs before network: %j', async overrides => {
    const { api, requestRaw } = fixture({});
    await expect(api.collect({ ...message, ...overrides } as CollectEmojiOptions)).rejects.toThrow('Invalid Desktop');
    expect(requestRaw).not.toHaveBeenCalled();
  });

  it.each(['', '<html>not JSON</html>', 'null', '[]'])('never retries an ambiguous body: %j', async body => {
    const { api, requestRaw } = fixture(body);
    await expect(api.collect(message)).rejects.toThrow();
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('propagates network failures once without marking collected', async () => {
    const { api, requestRaw } = fixture({});
    requestRaw.mockRejectedValue(new Error('timeout'));
    await expect(api.collect(message)).rejects.toThrow('timeout');
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it.each(['bdturing-verify', 'x-tt-verify-passport-decision'])('does not accept success-shaped JSON when challenged via %s', async header => {
    const { api, requestRaw } = fixture({ status_code: 0, success_items: [{ id: '1' }] }, new Headers({ [header]: '{}' }));
    await expect(api.collect(message)).rejects.toBeInstanceOf(ActionChallengeError);
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });
});
