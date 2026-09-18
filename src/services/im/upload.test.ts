import { ApiConnection } from '../../desktop/api-connection.js';
import {
  canonicalUploadQuery,
  crc32Hex,
  ImMediaUploader,
  signVodRequest,
  uploadProcessFunctions,
} from './upload.js';

describe('IM VOD upload algorithms', () => {
  it('propagates server-selected GCM parameters into file storage and commit', async () => {
    const userAgent = 'Mozilla/5.0 (synthetic owned upload identity) fixture/1.2.1';
    let storageHeaders: Headers | undefined;
    let commitBody: Record<string, unknown> | undefined;
    const fetcher = jest.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(String(input));
      expect(new Headers(init?.headers).get('user-agent')).toBe(userAgent);
      if (url.searchParams.get('Action') === 'ApplyUploadInner') {
        expect(url.searchParams.get('OpenGcmEnc')).toBe('true');
        return new Response(JSON.stringify({ Result: {
          UploadAddress: { StoreInfos: [{ StoreUri: 'wrong-imagex-route', Auth: 'wrong' }], UploadHosts: ['wrong.test'], SessionKey: 'wrong' },
          SDKParam: { server_gcm_encryption_mode: 2 },
          InnerUploadAddress: {
            AdvanceOption: { EncryptionKey: 'test-key' },
            UploadNodes: [{ StoreInfos: [{ StoreUri: 'file', Auth: 'auth' }], UploadHost: 'upload.test', SessionKey: 'session', UploadHeader: { 'X-Vod-Upload-PSM': 'test-psm' } }],
          },
        } }));
      }
      if (url.hostname === 'upload.test') {
        storageHeaders = new Headers(init?.headers);
        return new Response('{"code":2000}');
      }
      if (url.searchParams.get('Action') === 'CommitUploadInner') {
        commitBody = JSON.parse(Buffer.from(init?.body as Uint8Array).toString()) as Record<string, unknown>;
        return new Response(JSON.stringify({ Result: { Results: [{ Encryption: { Uri: 'tos/file', SecretKey: 'secret', SourceMd5: 'md5' } }] } }));
      }
      return new Response(JSON.stringify({ public_file_config: { access_key_id: 'ak', secret_access_key: 'sk', session_token: 'token', space_name: 'files' } }));
    });
    const uploader = new ImMediaUploader(new ApiConnection({ userAgent }), async () => '1', fetcher as typeof fetch);
    await expect(uploader.uploadFile(Buffer.from('test'), 'test.txt')).resolves.toMatchObject({ uri: 'tos/file', skey: 'secret' });
    expect(storageHeaders?.get('X-Upload-Server-Gcm-Encryption-Mode')).toBe('2');
    expect(storageHeaders?.get('X-Upload-Server-Gcm-Encryption-Key')).toBe('test-key');
    expect(storageHeaders?.get('X-Vod-Upload-PSM')).toBe('test-psm');
    expect(commitBody).toEqual({ SessionKey: 'session', Functions: [], EncryptionMode: '2', EncryptionKey: 'test-key' });
  });

  it('uses RFC3986 ordering for canonical query strings', () => {
    expect(canonicalUploadQuery({ z: 'a b', Action: 'A/B', bang: '!' }))
      .toBe('Action=A%2FB&bang=%21&z=a%20b');
  });

  it('computes the standard CRC32 check value', () => {
    expect(crc32Hex(Buffer.from('123456789'))).toBe('cbf43926');
  });

  it('produces deterministic SigV4 headers', () => {
    const signed = signVodRequest({
      method: 'GET', query: { Action: 'ApplyUploadInner', Version: '2020-11-19' },
      credentials: { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN', spaceName: 'space' },
      date: new Date('2026-08-26T12:34:56.000Z'),
    });
    expect(signed.headers['x-amz-date']).toBe('20260826T123456Z');
    expect(signed.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKID\/20260826\/cn-north-1\/vod\/aws4_request,/);
    expect(signed.authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it('uses the desktop 1.2.1 encryption policies for image, GIF, and video commits', () => {
    expect(uploadProcessFunctions('image')).toEqual([{
      name: 'Encryption',
      input: {
        Config: { copies: 'cipher_v2' },
        PolicyParams: { 'policy-set': 'check,thumb,medium,large' },
      },
    }]);
    expect(uploadProcessFunctions('image', 'gif')[0]?.input.PolicyParams).toEqual({
      'policy-set': 'still',
      'still-width': '480',
      'still-height': '480',
    });
    expect(uploadProcessFunctions('video')[0]?.input.Config).toEqual({
      copies: 'cipher_v2',
      aes_chunk_size: '524288',
    });
    expect(uploadProcessFunctions('object')).toEqual([]);
  });

  it('commits an image with desktop encryption functions and uses server image metadata', async () => {
    let commitBody: Record<string, unknown> | undefined;
    const fetcher = jest.fn(async (
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const url = new URL(String(input));
      const action = url.searchParams.get('Action');
      if (action === 'ApplyUploadInner') {
        return new Response(JSON.stringify({
          Result: {
            UploadAddress: {
              StoreInfos: [{ StoreUri: 'image', Auth: 'auth' }],
              UploadHosts: ['upload.test'],
              SessionKey: 'session',
            },
          },
        }));
      }
      if (action === 'CommitUploadInner') {
        commitBody = JSON.parse(Buffer.from(init?.body as Uint8Array).toString()) as Record<string, unknown>;
        return new Response(JSON.stringify({
          Result: {
            Results: [{
              Encryption: {
                Uri: 'tos/image',
                SecretKey: 'secret',
                SourceMd5: 'md5',
                Extra: { img_size: 70, img_width: 320, img_height: 240 },
              },
            }],
          },
        }));
      }
      if (url.hostname === 'upload.test') return new Response('{"code":2000}');
      return new Response(JSON.stringify({
        public_image_config: {
          access_key_id: 'ak',
          secret_access_key: 'sk',
          session_token: 'token',
          space_name: 'images',
        },
      }));
    });
    const uploader = new ImMediaUploader(
      new ApiConnection(),
      async () => '1',
      fetcher as typeof fetch,
    );
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    const asset = await uploader.uploadImage(png);

    expect(commitBody).toEqual({
      SessionKey: 'session',
      Functions: uploadProcessFunctions('image', 'png'),
    });
    expect(asset).toEqual({
      oid: 'tos/image', skey: 'secret', md5: 'md5', dataSize: 70,
      width: 320, height: 240, format: 'png',
    });
  });
});
