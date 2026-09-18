import { parseMessageContent } from './content.js';
import { pickImageUrl } from './media.js';

describe('Douyin Web inbound content variants', () => {
  it('recognizes URL-only images without requiring an encrypted object id', () => {
    const parsed = parseMessageContent(JSON.stringify({
      resource_url: { origin_url_list: ['https://example.test/image.jpg'] },
    }), 27);
    expect(parsed.kind).toBe('image');
    if (parsed.kind !== 'image') throw new Error('expected image');
    expect(pickImageUrl(parsed.image)).toBe('https://example.test/image.jpg');
    expect(parsed.image.oid).toBe('');
  });

  it('uses the wire type to distinguish voice from an image-shaped resource', () => {
    const value = {
      resource_url: { uri: 'voice/object', url_list: ['https://example.test/voice'] },
      duration: 1200,
      experiment: 'preserved',
    };
    expect(parseMessageContent(JSON.stringify(value), 17)).toEqual({
      kind: 'audio', text: '', aweType: 0,
      audio: { uri: 'voice/object', urls: ['https://example.test/voice'] },
      value,
    });
  });

  it('keeps shared work ids as strings and preserves card metadata', () => {
    const value = {
      itemId: '7391234567890123456', content_title: '作品标题',
      uid: '9007199254740993', secUID: 'MS4author', aweType: 800,
      content_thumb: { url_list: ['https://example.test/cover.jpg'] },
    };
    for (const messageType of [8, undefined]) {
      expect(parseMessageContent(JSON.stringify(value), messageType)).toEqual({
        kind: 'share', text: '作品标题', aweType: 800,
        share: { itemId: value.itemId, title: '作品标题', authorUid: value.uid, authorSecUid: 'MS4author' },
        value,
      });
    }
  });

  it.each([16, 75, 105])('parses comment card message type %i', (messageType) => {
    const value = {
      itemId: '7391234567890123456',
      comment_id: '7400000000000000001',
      comment_user_name: '评论者',
      comment: '这是一条评论',
      cover_url: { url_list: ['https://example.test/cover.jpg'] },
    };
    expect(parseMessageContent(JSON.stringify(value), messageType)).toEqual({
      kind: 'comment', text: '这是一条评论', aweType: 0, value,
      comment: {
        workId: value.itemId,
        commentId: value.comment_id,
        authorName: '评论者',
        coverUrl: 'https://example.test/cover.jpg',
      },
    });
  });

  it('does not reinterpret unknown resource messages as images', () => {
    const value = { resource_url: { uri: 'file/object' } };
    expect(parseMessageContent(JSON.stringify(value), 999)).toMatchObject({ kind: 'unknown', value });
  });

  it('handles missing and malformed resource fields without throwing', () => {
    expect(parseMessageContent('{"resource_url":null}', 17)).toMatchObject({
      kind: 'audio', audio: { urls: [], uri: '' },
    });
    expect(parseMessageContent('{"resource_url":{"url_list":[null,42,"https://example.test/a"]}}', 17))
      .toMatchObject({ audio: { urls: ['https://example.test/a'] } });
    expect(parseMessageContent('{"resource_url":{"origin_url_list":[null,42]}}', 27).kind).toBe('unknown');
    for (const content of ['null', '[]', '42']) {
      expect(parseMessageContent(content, 17).kind).toBe('unknown');
    }
    expect(parseMessageContent('ordinary text')).toMatchObject({ kind: 'text', text: 'ordinary text' });
  });
});
