import { ApiConnection } from '../../desktop/api-connection.js';
import { OutboundSender } from '../../sdk/messaging/outbound.js';
import { segment } from '../../sdk/messaging/message.js';
import { buildCardMessage, type CardMessage } from './cards.js';
import { parseMessageContent } from './content.js';
import { ImMediaUploader } from './upload.js';

const cases: Array<[CardMessage, number, string]> = [
  [
    { type: 'share', work: { itemId: '7391234567890123456', title: '作品' } },
    8,
    'share',
  ],
  [
    { type: 'photos', work: { itemId: '7391234567890123456', imageCount: 3 } },
    77,
    'share',
  ],
  [
    {
      type: 'link',
      link: { url: 'https://example.test/?q=hello', title: '网页' },
    },
    26,
    'link',
  ],
  [
    { type: 'user', user: { uid: '9007199254740993', name: '用户' } },
    25,
    'user',
  ],
  [
    {
      type: 'file',
      file: {
        uri: 'tos/key',
        skey: 'secret',
        md5: 'abc',
        name: 'a.pdf',
        dataSize: 100,
      },
    },
    6,
    'file',
  ],
];
describe('IM card families', () => {
  it.each(cases)(
    'round-trips %j with wire type %i',
    (message, wireType, kind) => {
      const built = buildCardMessage(message);
      expect(built.messageType).toBe(wireType);
      expect(parseMessageContent(built.content, wireType).kind).toBe(kind);
    }
  );
  it('builds the PC iframe link and rejects unsupported URL schemes', () => {
    const card = JSON.parse(
      buildCardMessage({
        type: 'link',
        link: { url: 'https://example.test/?q=1' },
      }).content
    );
    expect(new URL(card.link_url).searchParams.get('pc_iframe_src')).toBe(
      'https://example.test/?q=1'
    );
    expect(() =>
      buildCardMessage({ type: 'link', link: { url: 'javascript:alert(1)' } })
    ).toThrow('HTTP');
  });
  it('sends every card through Desktop HTTP without text normalization', async () => {
      const sender = new OutboundSender(new ApiConnection());
      const http = jest
        .spyOn(sender.imService, 'send')
        .mockResolvedValue({
          statusCode: 0,
          statusMsg: 'OK',
          serverMessageId: '1',
        });
      for (const [message, messageType] of cases) {
        await sender.sendMessage({
          threadId: '70001',
          conversationShortId: '70001',
          conversationType: 2,
          message,
        });
        const call = http.mock.calls.at(-1)![0];
        expect(call).toMatchObject({
          conversationType: 2,
          msgType: messageType,
        });
        expect(JSON.parse(call.content)).not.toHaveProperty('text');
      }
  });
  it('resolves a public image source before upload and sends image wire type 27', async () => {
    const sender = new OutboundSender(new ApiConnection());
    const uploadImage = jest.spyOn(sender.imService, 'uploadImage').mockResolvedValue({
      oid: 'tos/image', skey: 'secret', md5: 'md5', dataSize: 68,
      width: 1, height: 1, format: 'png',
    });
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({
      statusCode: 0,
      statusMsg: 'OK',
      serverMessageId: '1',
    });
    const base64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    await sender.sendMessage({
      threadId: '0:1:1:2',
      conversationShortId: '2',
      message: segment.image(`data:image/png;base64,${base64}`),
    });

    expect(Buffer.from(uploadImage.mock.calls[0]![0])).toEqual(Buffer.from(base64, 'base64'));
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ msgType: 27 }));
  });
  it('forwards a work card with its original wire type and desktop source chain', async () => {
    const sender = new OutboundSender(new ApiConnection());
    const send = jest.spyOn(sender.imService, 'send').mockResolvedValue({
      statusCode: 0,
      statusMsg: 'OK',
      serverMessageId: '2',
    });

    await sender.forwardMessage({
      threadId: '70002',
      conversationShortId: '70002',
      conversationType: 2,
      messageType: 8,
      serverMessageId: '7390000000000000001',
      content: JSON.stringify({ itemId: '7380000000000000001', root_id: '7370000000000000001' }),
    });

    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      threadId: '70002',
      msgType: 8,
    }));
    expect(send.mock.calls[0]![0].content).toBe(
      '{"itemId":"7380000000000000001","root_id":7370000000000000001,"prev_id":7390000000000000001}',
    );
  });
  it('uploads file bytes using file STS, object/GCM apply and validates size before requests', async () => {
    const requests: URL[] = [];
    const fetcher = jest.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = new URL(String(input));
      requests.push(url);
      if (url.searchParams.get('Action') === 'ApplyUploadInner')
        return new Response(
          JSON.stringify({
            Result: {
              SDKParam: { server_gcm_encryption_mode: '1' },
              InnerUploadAddress: {
                AdvanceOption: { EncryptionKey: 'fixture-key' },
                UploadNodes: [{
                  StoreInfos: [{ StoreUri: 'object', Auth: 'auth' }],
                  UploadHost: 'upload.test',
                  SessionKey: 'session',
                }],
              },
            },
          })
        );
      if (url.searchParams.get('Action') === 'CommitUploadInner')
        return new Response(
          JSON.stringify({
            Result: {
              Results: [
                {
                  Encryption: {
                    Uri: 'tos/key',
                    SecretKey: 'secret',
                    SourceMd5: 'md5',
                  },
                },
              ],
            },
          })
        );
      if (url.hostname === 'upload.test') return new Response('{"code":2000}');
      return new Response(
        JSON.stringify({
          public_file_config: {
            access_key_id: 'ak',
            secret_access_key: 'sk',
            session_token: 'token',
            space_name: 'files',
          },
        })
      );
    });
    const uploader = new ImMediaUploader(
      new ApiConnection(),
      async () => '1',
      fetcher as typeof fetch
    );
    const file = await uploader.uploadFile(Buffer.from('data'), 'test.txt');
    expect(file).toMatchObject({
      uri: 'tos/key',
      name: 'test.txt',
      dataSize: 4,
    });
    expect(
      requests
        .find(url => url.searchParams.get('Action') === 'ApplyUploadInner')
        ?.searchParams.get('OpenGcmEnc')
    ).toBe('true');
    expect(
      requests
        .find(url => url.searchParams.get('Action') === 'ApplyUploadInner')
        ?.searchParams.get('FileType')
    ).toBe('object');
    const before = fetcher.mock.calls.length;
    await expect(
      uploader.uploadFile(new Uint8Array(), 'empty')
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(before);
    expect(segment.file(file)).toEqual({ type: 'file', file });
  });
});
