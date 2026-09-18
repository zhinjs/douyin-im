import { ImEmojiApi, mergeCollectedEmojiPage, addCollectedEmoji, type CollectedEmojiSnapshot } from './emoji.js';
import type { ImHttpClient } from './service.js';

function fixture(page: unknown, raw?: string) {
  const requestRaw = jest.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), data: '',
    rawText: raw ?? JSON.stringify({ custom_sticker_page_list: page }) });
  return { requestRaw, api: new ImEmojiApi({ requestRaw, getUserAgent: () => 'fixture-UA', getInstallId: () => 'iid' } as unknown as ImHttpClient, 'did', 'guid') };
}

function page(stickers: unknown[] = []) {
  return { resources: [{ stickers }], next_cursor: '50', is_completed: false, sticker_enabled_status: 0 };
}

describe('Desktop collected emoji pages', () => {
  it('uses the exact aggregation scene, 50-item limit, cursor and root nested page', async () => {
    const { api, requestRaw } = fixture(page([{ id: '1' }, { id: '2' }]));
    await expect(api.getCollected('9007199254740993123')).resolves.toEqual({ statusCode: 0, statusMsg: '',
      page: { nextCursor: '50', hasMore: true, stickerEnabledStatus: 0, stickers: [{ id: '2' }, { id: '1' }] } });
    const [input, init, passport] = requestRaw.mock.calls[0]!;
    const url = new URL(input);
    expect(url.pathname).toBe('/aweme/v1/web/im_communication/resources/list/aggregation/');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ scenes: 'CUSTOM_STICKER_PAGE', need_ai_emoji: 'true',
      custom_cursor: '9007199254740993123', custom_limit: '50', device_id: 'did', iid: 'iid', awemeim_guid: 'guid' });
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers.bgint_json_parser).toBe('2');
    expect(passport).toBe(false);
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it('distinguishes no resource update, metadata-only update and a genuinely empty sticker page', async () => {
    await expect(fixture({ resources: [] }).api.getCollected()).resolves.toEqual({ statusCode: 0, statusMsg: '' });
    await expect(fixture({ ...page(), resources: [{}] }).api.getCollected()).resolves.toEqual({ statusCode: 0, statusMsg: '',
      page: { nextCursor: '50', hasMore: true, stickerEnabledStatus: 0 } });
    await expect(fixture(page()).api.getCollected()).resolves.toMatchObject({ page: { stickers: [] } });
    await expect(fixture({ ...page(), resources: [{ name: 'empty' }] }).api.getCollected()).resolves.toMatchObject({ page: { stickers: [] } });
  });

  it('uses only resources[0], filters before reversing, and retains numeric video IDs', async () => {
    const data = page([{ id: '1', video_id: '9' }, { id: '2', video_id: 9 }, { id: '3', video_id: '' },
      { id: '4', video_id: '10' }, { id: '5' }]);
    data.resources.push({ stickers: [{ id: '6' }] });
    const result = await fixture({ ...data, forbidden_sticker_ids: ['9', 10] }).api.getCollected();
    expect(result.page?.stickers?.map(item => item['id'])).toEqual(['5', '4', '3', '2']);
  });

  it('preserves large JSON integer IDs before exact-value forbidden filtering', async () => {
    const raw = '{"custom_sticker_page_list":{"resources":[{"stickers":[{"id":9007199254740993123,"video_id":9007199254740993001},{"id":2,"video_id":9}]}],"forbidden_sticker_ids":[9007199254740993001,9],"next_cursor":9007199254740993124,"is_completed":true}}';
    const result = await fixture(null, raw).api.getCollected();
    expect(result.page).toEqual({ nextCursor: '9007199254740993124', hasMore: false, stickers: [{ id: 2, video_id: 9 }] });
  });

  it.each([true, false, 0, 1])('reflects is_completed=%j without triggering the next page itself', async completed => {
    const { api, requestRaw } = fixture({ ...page(), is_completed: completed });
    await expect(api.getCollected()).resolves.toMatchObject({ page: { hasMore: !completed } });
    expect(requestRaw).toHaveBeenCalledTimes(1);
  });

  it.each(['0', '1', false, null])('preserves group-policy JSON scalar %j for the original selector', async enabled => {
    const { api } = fixture({ ...page(), sticker_enabled_status: enabled });
    await expect(api.getCollected()).resolves.toMatchObject({ page: { stickerEnabledStatus: enabled } });
  });

  it.each([null, {}, { resources: null }, { ...page(), next_cursor: null }, { ...page(), is_completed: 'false' },
    { ...page(), resources: [null] }, page([{}]), page(['item']), { ...page(), forbidden_sticker_ids: {} }])('does not project malformed pages into an empty success: %j', async input => {
    await expect(fixture(input).api.getCollected()).resolves.toMatchObject({ statusCode: -3 });
  });

  it('preserves root status while still projecting a valid page, as Desktop does', async () => {
    const { api } = fixture(null, JSON.stringify({ status_code: 8, status_msg: 'login required', custom_sticker_page_list: page() }));
    await expect(api.getCollected()).resolves.toEqual({ statusCode: 8, statusMsg: 'login required',
      page: { nextCursor: '50', hasMore: true, stickerEnabledStatus: 0, stickers: [] } });
    await expect(fixture(null, '{"status_code":8,"status_msg":"login required"}').api.getCollected())
      .resolves.toEqual({ statusCode: 8, statusMsg: 'login required' });
  });

  it.each(['-1', '1e3', '1.5', '', '1&custom_limit=100', 50])('rejects invalid cursors before dispatch: %j', async cursor => {
    const { api, requestRaw } = fixture(page());
    await expect(api.getCollected(cursor as string)).rejects.toThrow('Invalid Desktop emoji cursor');
    expect(requestRaw).not.toHaveBeenCalled();
  });
});

describe('Desktop collected emoji snapshot merging', () => {
  const current: CollectedEmojiSnapshot = { stickers: [{ id: '10', name: 'old' }, { id: '20' }],
    nextCursor: '50', hasMore: true, stickerEnabledStatus: 0 };
  it('replaces first pages with last duplicate winning, while later pages keep the first existing item', () => {
    const page = { nextCursor: '100', hasMore: false, stickerEnabledStatus: 1,
      stickers: [{ id: '10', name: 'first' }, { id: '30' }, { id: '10', name: 'last' }] };
    expect(mergeCollectedEmojiPage(current, page, true).stickers).toEqual([{ id: '10', name: 'last' }, { id: '30' }]);
    expect(mergeCollectedEmojiPage(current, page, false).stickers).toEqual([...current.stickers, { id: '30' }]);
    expect(current.stickers[0]).toEqual({ id: '10', name: 'old' });
  });

  it('metadata-only first pages retain entities, but an explicit empty first page clears them', () => {
    const metadata = { nextCursor: '100', hasMore: false };
    expect(mergeCollectedEmojiPage(current, metadata, true).stickers).toEqual(current.stickers);
    expect(mergeCollectedEmojiPage(current, { ...metadata, stickers: [] }, true).stickers).toEqual([]);
    expect(mergeCollectedEmojiPage(current, { ...metadata, stickers: [] }, false).stickers).toEqual(current.stickers);
  });

  it('does not mutate or share result records with callers', () => {
    const incoming = { nextCursor: '100', hasMore: false, stickers: [{ id: '30', nested: { value: 1 } }] };
    const state = mergeCollectedEmojiPage(current, incoming, false);
    incoming.stickers[0]!.nested.value = 2;
    expect(state.stickers[2]).toEqual({ id: '30', nested: { value: 1 } });
  });

  it('only adds an actually returned sticker ID, preserving existing records on duplicate success', () => {
    expect(addCollectedEmoji(undefined, { anything: true })).toBeUndefined();
    expect(addCollectedEmoji(current, { id: '10', name: 'changed' })).toBe(current);
    expect(addCollectedEmoji(current, { id: '30' })?.stickers.map(item => item['id'])).toEqual(['30', '10', '20']);
  });

  it('uses Desktop Object.values integer-key ordering when prepending a confirmed collection', () => {
    const state = { ...current, stickers: [{ id: 'a' }, { id: '10' }, { id: '2' }, { id: '__proto__' }] };
    expect(addCollectedEmoji(state, { id: 'new' })?.stickers.map(item => item['id'])).toEqual(['new', '2', '10', 'a', '__proto__']);
  });
});
