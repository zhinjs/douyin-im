import type { ImHttpClient } from './service.js';
import { ImSharedContent, resolveSharedWorkAccess } from './shared-content.js';

function jsonResponse(value: unknown) {
  const rawText = JSON.stringify(value);
  return { ok: true, status: 200, headers: new Headers(), data: rawText, rawText };
}

describe('ImSharedContent', () => {
  it('uses the desktop work-detail form and batches at 50 ids', async () => {
    const requestRaw = jest.fn()
      .mockResolvedValueOnce(jsonResponse({
        aweme_details: [{ aweme_id: '1', video: {} }],
        filter_list: [{ aweme_id: '2', reason: 7 }],
      }))
      .mockResolvedValueOnce(jsonResponse({ aweme_details: [{ aweme_id: '51' }] }));
    const content = new ImSharedContent({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, async () => 'device-1');

    const ids = Array.from({ length: 51 }, (_, index) => String(index + 1));
    const result = await content.getWorkDetails('70001', ids);

    expect(result).toEqual([
      { workId: '1', filtered: false, detail: { aweme_id: '1', video: {} } },
      { workId: '2', filtered: true, reason: 7 },
      { workId: '51', filtered: false, detail: { aweme_id: '51' } },
    ]);
    expect(requestRaw).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = requestRaw.mock.calls[0]!;
    expect(new URL(firstUrl).pathname).toBe('/aweme/v1/web/multi/aweme/detail/');
    expect(firstInit.method).toBe('POST');
    expect(firstInit.headers).toMatchObject({ bgint_json_parser: '2' });
    const body = firstInit.body as FormData;
    expect(body.get('aweme_ids')).toBe(`[${ids.slice(0, 50).join(',')}]`);
    expect(body.get('origin_type')).toBe('chat');
    expect(body.get('request_source')).toBe('3');
    expect(body.get('conversation_short_id')).toBe('70001');
  });

  it('uses the desktop comment-status form and exposes is_show', async () => {
    const requestRaw = jest.fn().mockResolvedValue(jsonResponse({
      comment_status_resp: {
        comments_status: [
          { comment_id: '91', is_show: true },
          { comment_id: '92', is_show: 0, reason: 'deleted' },
        ],
      },
    }));
    const content = new ImSharedContent({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, async () => 'device-1');

    await expect(content.getCommentStatuses('70001', ['91', '92'])).resolves.toEqual([
      { commentId: '91', isShown: true, raw: { comment_id: '91', is_show: true } },
      { commentId: '92', isShown: false, raw: { comment_id: '92', is_show: 0, reason: 'deleted' } },
    ]);
    const [rawUrl, init] = requestRaw.mock.calls[0]!;
    expect(new URL(rawUrl).pathname).toBe('/aweme/v1/web/im/message/info/other/');
    const body = init.body as FormData;
    expect(body.get('comments_status_req')).toBe('{"comment_id_list":["91","92"]}');
    expect(body.get('conversation_short_id')).toBe('70001');
  });

  it('extracts only the download fields used by the desktop player', () => {
    expect(resolveSharedWorkAccess({
      workId: '1', filtered: false,
      detail: {
        video_control: { allow_download: true, allow_share: false },
        aweme_control: { can_share: true },
        images: [
          { download_url_list: ['https://cdn.test/1.jpg', 'https://backup.test/1.jpg'] },
          { download_url_list: ['https://cdn.test/2.jpg'] },
        ],
      },
    })).toEqual({
      workId: '1', canShare: true, canDownload: true,
      media: [
        { kind: 'image', url: 'https://cdn.test/1.jpg', urls: ['https://cdn.test/1.jpg', 'https://backup.test/1.jpg'] },
        { kind: 'image', url: 'https://cdn.test/2.jpg', urls: ['https://cdn.test/2.jpg'] },
      ],
    });
    expect(resolveSharedWorkAccess({
      workId: '2', filtered: false,
      detail: {
        video_control: { allow_download: false, allow_share: true },
        video: { download_addr: { url_list: ['https://cdn.test/video.mp4'] } },
      },
    })).toEqual({
      workId: '2', canShare: true, canDownload: false,
      media: [],
    });
  });

  it('rejects unsafe numeric shapes before dispatch', async () => {
    const requestRaw = jest.fn();
    const content = new ImSharedContent({ requestRaw, getUserAgent: () => 'fixture-UA' } as unknown as ImHttpClient, async () => 'device-1');
    await expect(content.getWorkDetails('not-a-conversation', ['1'])).rejects.toThrow('conversationShortId');
    await expect(content.getWorkDetails('70001', ['1e3'])).rejects.toThrow('work id');
    expect(requestRaw).not.toHaveBeenCalled();
  });
});
