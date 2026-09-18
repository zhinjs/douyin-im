import type { ImService } from './service.js';
import type { ImStateStore } from './state-store.js';
import type { ImActionResponse, RecentStrangerMessagesResponse, StrangerSyncCursors } from './types.js';
import { normalizeStrangerCursors } from './stranger-cursors.js';

export interface StrangerSyncResult extends ImActionResponse {
  /** Successfully consumed pages/outer rows. Not a complete local list or a remote total. */
  pages: number;
  conversations: number;
}

/**
 * Native StrangerChainPuller pagination and durable cursor boundary, not a contact facade.
 * The owner consumes each complete page before its cursors commit, and must dispose this
 * instance on logout. Conversation assembly/events and trim belong to that owner.
 */
export class StrangerSync {
  private transient = normalizeStrangerCursors();
  private stopped = false;
  private refreshing?: Promise<StrangerSyncResult>;
  private loading?: Promise<StrangerSyncResult>;

  constructor(private readonly options: {
    im: Pick<ImService, 'getRecentStrangerMessages'>;
    store?: Pick<ImStateStore, 'getStrangerSyncCursors' | 'setStrangerSyncCursors'>;
    /** Must include the owner's login-generation/connection check. */
    assertActive(): void;
    consumePage(page: RecentStrangerMessagesResponse): void | Promise<void>;
  }) {}

  close(): void { this.stopped = true; }

  refresh(): Promise<StrangerSyncResult> {
    this.assertActive();
    // Native has separate re-entry guards. SDK callers share the result of the active run.
    if (this.refreshing) return this.refreshing;
    const run = this.run('refresh');
    this.refreshing = run;
    void run.then(() => { if (this.refreshing === run) delete this.refreshing; },
      () => { if (this.refreshing === run) delete this.refreshing; });
    return run;
  }

  loadMore(): Promise<StrangerSyncResult> {
    this.assertActive();
    if (this.loading) return this.loading;
    const run = this.run('loadMore');
    this.loading = run;
    void run.then(() => { if (this.loading === run) delete this.loading; },
      () => { if (this.loading === run) delete this.loading; });
    return run;
  }

  private assertActive(): void {
    if (this.stopped) throw new Error('Stranger sync is closed');
    this.options.assertActive();
  }

  private cursors(): StrangerSyncCursors {
    this.assertActive();
    return normalizeStrangerCursors(this.options.store?.getStrangerSyncCursors() ?? this.transient);
  }

  private commit(cursors: StrangerSyncCursors): void {
    this.assertActive();
    const next = normalizeStrangerCursors(cursors);
    this.options.store?.setStrangerSyncCursors(next);
    this.transient = next;
  }

  private async run(mode: 'refresh' | 'loadMore'): Promise<StrangerSyncResult> {
    const initial = this.cursors();
    const originalLatest = mode === 'refresh' ? 9223372036854775807n : BigInt(initial.loadMoreVersion);
    const earliest = mode === 'refresh' && BigInt(initial.version) > 0n ? BigInt(initial.version) : 0n;
    let latest = originalLatest;
    let pages = 0;
    let conversations = 0;
    for (;;) {
      this.assertActive();
      const page = await this.options.im.getRecentStrangerMessages({
        inboxType: 1, latestStrangerVersion: String(latest), earliestStrangerVersion: String(earliest),
      });
      this.assertActive();
      if (page.statusCode !== 0) return { statusCode: page.statusCode, statusMsg: page.statusMsg, pages, conversations };
      const next = BigInt(page.nextStrangerVersion);
      const count = page.messages.length;
      const hasMore = page.hasMore;
      const more = mode === 'refresh' && hasMore && next > earliest && conversations + count < 200;
      // SDK defense, not a native condition: reject non-descending continuing pages before consumption/commit.
      if (more && next >= latest) return { statusCode: -3, statusMsg: 'Stranger sync version did not descend', pages, conversations };
      const maxVersion = page.messages.reduce((max, row) => {
        const version = BigInt(row.version);
        return version > max ? version : max;
      }, 0n);
      await this.options.consumePage(page);
      this.assertActive();
      // Read afresh: refresh and loadMore may overlap while HTTP/page processing was pending.
      const current = this.cursors();
      let loadMoreVersion = BigInt(current.loadMoreVersion);
      if (mode === 'loadMore') {
        if (next > 0n && loadMoreVersion === originalLatest) loadMoreVersion = next;
      } else {
        const boundary = hasMore ? next : earliest;
        if ((!hasMore || boundary > 0n) && (loadMoreVersion < 1n || loadMoreVersion > boundary)) {
          loadMoreVersion = boundary;
        }
      }
      const version = mode === 'refresh' && pages === 0 && maxVersion > 0n ? String(maxVersion) : current.version;
      const updated = { version, loadMoreVersion: String(loadMoreVersion) };
      if (updated.version !== current.version || updated.loadMoreVersion !== current.loadMoreVersion) this.commit(updated);
      pages++;
      conversations += count;
      if (!more) return { statusCode: 0, statusMsg: page.statusMsg, pages, conversations };
      latest = next;
    }
  }
}
