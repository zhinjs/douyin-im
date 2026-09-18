import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createImStateStore, type ImStateStore, type ImStateStoreBackend } from './state-store.js';
import { StrangerSync } from './stranger-sync.js';
import type { RecentStrangerMessagesResponse, StrangerSyncCursors } from './types.js';

function page(next: string, hasMore: boolean, versions: string[] = []): RecentStrangerMessagesResponse {
  return { statusCode: 0, statusMsg: '', nextStrangerVersion: next, hasMore, logId: '',
    messages: versions.map(version => ({ conversationId: `c${version}`, conversationShortId: version,
      version, badgeCount: 0, messages: [] })) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe.each<ImStateStoreBackend>(['sqlite', 'json'])('stranger pagination with %s', backend => {
  let directory: string;
  let store: ImStateStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'douyin-stranger-sync-'));
    store = createImStateStore({ accountDir: directory, backend });
  });
  afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  function setup(initial?: StrangerSyncCursors) {
    if (initial) store.setStrangerSyncCursors(initial);
    const request = jest.fn<Promise<RecentStrangerMessagesResponse>, [unknown]>();
    const consumePage = jest.fn<void | Promise<void>, [RecentStrangerMessagesResponse]>();
    const assertActive = jest.fn();
    const sync = new StrangerSync({ im: { getRecentStrangerMessages: request }, store, consumePage, assertActive });
    return { sync, request, consumePage, assertActive };
  }

  it('preserves signed int64 defaults, copies, account isolation and restart without a Session migration', () => {
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' });
    const input = { version: '9007199254740993', loadMoreVersion: '-9223372036854775808' };
    store.setStrangerSyncCursors(input);
    input.version = '1';
    const snapshot = store.getStrangerSyncCursors(); snapshot.version = '2';
    store.setFrontierCursors('different-space', []);
    store.close(); store = createImStateStore({ accountDir: directory, backend });
    expect(store.getStrangerSyncCursors()).toEqual({ version: '9007199254740993', loadMoreVersion: '-9223372036854775808' });
    const other = createImStateStore({ accountDir: join(directory, 'other-account'), backend });
    try { expect(other.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' }); }
    finally { other.close(); }
    for (const value of ['9223372036854775808', '-9223372036854775809', 'NaN', '1.5', '']) {
      expect(() => store.setStrangerSyncCursors({ version: '4', loadMoreVersion: value })).toThrow();
    }
    expect(store.getStrangerSyncCursors().version).toBe('9007199254740993');
  });

  it('commits the first page only after consumption, then keeps its version when a later page has a higher version', async () => {
    const { sync, request, consumePage } = setup({ version: '20', loadMoreVersion: '90' });
    request.mockResolvedValueOnce(page('70', true, ['80', '90'])).mockResolvedValueOnce(page('999', false, ['100']));
    consumePage.mockImplementationOnce(() => { expect(store.getStrangerSyncCursors()).toEqual({ version: '20', loadMoreVersion: '90' }); });
    consumePage.mockImplementationOnce(() => { expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '70' }); });
    await expect(sync.refresh()).resolves.toEqual({ statusCode: 0, statusMsg: '', pages: 2, conversations: 3 });
    expect(request.mock.calls.map(([bounds]) => bounds)).toEqual([
      { inboxType: 1, latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '20' },
      { inboxType: 1, latestStrangerVersion: '70', earliestStrangerVersion: '20' },
    ]);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '20' });
  });

  it('does not roll back the first page or continue after a failed second page', async () => {
    const { sync, request } = setup();
    request.mockResolvedValueOnce(page('50', true, ['90'])).mockResolvedValueOnce({ ...page('0', false), statusCode: 8, statusMsg: 'denied' });
    await expect(sync.refresh()).resolves.toEqual({ statusCode: 8, statusMsg: 'denied', pages: 1, conversations: 1 });
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '50' });
    expect(request).toHaveBeenCalledTimes(2);
    store.close(); store = createImStateStore({ accountDir: directory, backend });
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '50' });
  });

  it('counts outer rows, accepts a complete oversized page, and does not truncate it at 200', async () => {
    const { sync, request, consumePage } = setup();
    const first = page('50', true, Array(199).fill('90') as string[]);
    first.messages[0]!.messages = Array(300).fill({ version: '999' });
    const last = page('20', true, ['40', '30']);
    request.mockResolvedValueOnce(first).mockResolvedValueOnce(last);
    await expect(sync.refresh()).resolves.toMatchObject({ statusCode: 0, pages: 2, conversations: 201 });
    expect(consumePage).toHaveBeenLastCalledWith(last);
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '20' });
  });

  it('only submits a positive maximum from the first page, even when it is below the previous stored version', async () => {
    const { sync, request } = setup({ version: '80', loadMoreVersion: '10' });
    request.mockResolvedValueOnce(page('40', false, ['-1', '0', '70']));
    await sync.refresh();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '70', loadMoreVersion: '10' });
    request.mockResolvedValueOnce(page('0', false, ['0', '-1']));
    await sync.refresh();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '70', loadMoreVersion: '10' });
  });

  it('normalizes a negative refresh boundary to zero but never promotes a later page after an empty first page', async () => {
    const { sync, request } = setup({ version: '-9', loadMoreVersion: '-1' });
    request.mockResolvedValueOnce(page('50', true)).mockResolvedValueOnce(page('0', false, ['90']));
    await expect(sync.refresh()).resolves.toMatchObject({ statusCode: 0, pages: 2, conversations: 1 });
    expect(request.mock.calls.map(([bounds]) => bounds)).toEqual([
      { inboxType: 1, latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '0' },
      { inboxType: 1, latestStrangerVersion: '50', earliestStrangerVersion: '0' },
    ]);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '-9', loadMoreVersion: '0' });
  });

  it('stops exactly at 200 outer rows even if the server reports more', async () => {
    const { sync, request, consumePage } = setup();
    const complete = page('50', true, Array<string>(200).fill('90'));
    request.mockResolvedValue(complete);
    await expect(sync.refresh()).resolves.toMatchObject({ statusCode: 0, pages: 1, conversations: 200 });
    expect(consumePage).toHaveBeenCalledWith(complete);
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '50' });
  });

  it('passes the initial negative load-more sentinel and takes just one page even when hasMore is true', async () => {
    const { sync, request } = setup();
    request.mockResolvedValue(page('90', true, ['100']));
    await expect(sync.loadMore()).resolves.toMatchObject({ statusCode: 0, pages: 1 });
    expect(request).toHaveBeenCalledWith({ inboxType: 1, latestStrangerVersion: '-1', earliestStrangerVersion: '0' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '90' });
  });

  it('does not overwrite a load-more boundary changed while its request was pending', async () => {
    const { sync, request } = setup({ version: '90', loadMoreVersion: '50' });
    const pending = deferred<RecentStrangerMessagesResponse>(); request.mockReturnValueOnce(pending.promise);
    const run = sync.loadMore();
    store.setStrangerSyncCursors({ version: '100', loadMoreVersion: '20' });
    pending.resolve(page('40', true, ['60'])); await run;
    expect(store.getStrangerSyncCursors()).toEqual({ version: '100', loadMoreVersion: '20' });
  });

  it('consumes load-more pages with nonpositive next versions without changing either cursor', async () => {
    const { sync, request, consumePage } = setup({ version: '90', loadMoreVersion: '50' });
    request.mockResolvedValueOnce(page('0', true, ['100'])).mockResolvedValueOnce(page('-1', false, ['110']));
    await sync.loadMore(); await sync.loadMore();
    expect(consumePage).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '50' });
  });

  it('coalesces same-mode work while permitting independent refresh/load-more', async () => {
    const { sync, request } = setup();
    const refresh = deferred<RecentStrangerMessagesResponse>(); const more = deferred<RecentStrangerMessagesResponse>();
    request.mockReturnValueOnce(refresh.promise).mockReturnValueOnce(more.promise);
    const a = sync.refresh(); const b = sync.refresh(); const c = sync.loadMore();
    expect(a).toBe(b); expect(request).toHaveBeenCalledTimes(2);
    refresh.resolve(page('0', false, ['90'])); await a;
    more.resolve(page('50', true)); await c;
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '0' });
  });

  it('drops a successful stale-login response before consuming or changing the new login cursors', async () => {
    const { sync, request, consumePage, assertActive } = setup();
    let generation = 1;
    assertActive.mockImplementation(() => { if (generation !== 1) throw new Error('login changed'); });
    const pending = deferred<RecentStrangerMessagesResponse>(); request.mockReturnValueOnce(pending.promise);
    const run = sync.refresh(); generation = 2;
    store.setStrangerSyncCursors({ version: '999', loadMoreVersion: '888' });
    pending.resolve(page('50', false, ['90']));
    await expect(run).rejects.toThrow('login changed');
    expect(consumePage).not.toHaveBeenCalled();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '999', loadMoreVersion: '888' });
  });

  it('does not commit when closed during page consumption', async () => {
    const { sync, request, consumePage } = setup();
    request.mockResolvedValue(page('50', true, ['90']));
    consumePage.mockImplementation(() => { sync.close(); });
    await expect(sync.refresh()).rejects.toThrow('closed');
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('propagates consume/persistence failures without committing that page cursors or retrying', async () => {
    const { sync, request, consumePage } = setup();
    request.mockResolvedValue(page('50', true, ['90']));
    consumePage.mockRejectedValueOnce(new Error('consumer failed'));
    await expect(sync.refresh()).rejects.toThrow('consumer failed');
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' });
    const save = jest.spyOn(store, 'setStrangerSyncCursors').mockImplementation(() => { throw new Error('disk failed'); });
    await expect(sync.refresh()).rejects.toThrow('disk failed');
    save.mockRestore();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('retains successful page cursors on a later network failure and releases the mode guard for an explicit new run', async () => {
    const { sync, request, consumePage } = setup();
    request.mockResolvedValueOnce(page('50', true, ['90'])).mockRejectedValueOnce(new Error('network failed'));
    await expect(sync.refresh()).rejects.toThrow('network failed');
    expect(request).toHaveBeenCalledTimes(2);
    expect(consumePage).toHaveBeenCalledTimes(1);
    expect(store.getStrangerSyncCursors()).toEqual({ version: '90', loadMoreVersion: '50' });
    request.mockResolvedValueOnce(page('0', false, ['100']));
    await expect(sync.refresh()).resolves.toMatchObject({ statusCode: 0, pages: 1 });
    expect(request).toHaveBeenLastCalledWith({ inboxType: 1, latestStrangerVersion: '9223372036854775807', earliestStrangerVersion: '90' });
    expect(store.getStrangerSyncCursors()).toEqual({ version: '100', loadMoreVersion: '50' });
  });

  it('rejects a continuing non-descending empty page instead of entering an infinite loop', async () => {
    const { sync, request, consumePage } = setup();
    request.mockResolvedValue(page('9223372036854775807', true));
    await expect(sync.refresh()).resolves.toMatchObject({ statusCode: -3, pages: 0 });
    expect(request).toHaveBeenCalledTimes(1); expect(consumePage).not.toHaveBeenCalled();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '0', loadMoreVersion: '-1' });
  });
});

it('keeps JSON in-memory cursors unchanged when writing the atomic replacement fails', () => {
  const directory = mkdtempSync(join(tmpdir(), 'douyin-stranger-write-'));
  const store = createImStateStore({ accountDir: directory, backend: 'json' });
  try {
    store.setStrangerSyncCursors({ version: '7', loadMoreVersion: '3' });
    mkdirSync(join(directory, 'im-state.json.tmp'));
    expect(() => store.setStrangerSyncCursors({ version: '9', loadMoreVersion: '4' })).toThrow();
    expect(store.getStrangerSyncCursors()).toEqual({ version: '7', loadMoreVersion: '3' });
    const restored = createImStateStore({ accountDir: directory, backend: 'json' });
    expect(restored.getStrangerSyncCursors()).toEqual({ version: '7', loadMoreVersion: '3' }); restored.close();
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('supports nonpersistent owners without leaking cursors to a new sync instance', async () => {
  const im = { getRecentStrangerMessages: jest.fn().mockResolvedValue(page('50', false, ['90'])) };
  const options = { im, assertActive: () => {}, consumePage: () => {} };
  const first = new StrangerSync(options); await first.refresh(); await first.loadMore(); first.close();
  const second = new StrangerSync(options); await second.loadMore();
  expect(im.getRecentStrangerMessages.mock.calls.map(call => call[0].latestStrangerVersion)).toEqual([
    '9223372036854775807', '0', '-1',
  ]);
});
