import { resolveImageSource } from './media-source.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG = Buffer.from(PNG_BASE64, 'base64');

describe('image source resolution', () => {
  it('accepts Buffer and Uint8Array values directly', async () => {
    await expect(resolveImageSource(PNG)).resolves.toMatchObject({ format: 'png' });
    await expect(resolveImageSource(new Uint8Array(PNG))).resolves.toMatchObject({ format: 'png' });
  });

  it('accepts raw base64 and base64 data URLs', async () => {
    const raw = await resolveImageSource(PNG_BASE64);
    const dataUrl = await resolveImageSource(`data:image/png;base64,${PNG_BASE64}`);

    expect(Buffer.from(raw.data)).toEqual(PNG);
    expect(Buffer.from(dataUrl.data)).toEqual(PNG);
  });

  it('reads a local file path through the filesystem seam', async () => {
    const readLocalFile = jest.fn().mockResolvedValue(PNG);

    const resolved = await resolveImageSource('/tmp/pixel.png', { readLocalFile });

    expect(readLocalFile).toHaveBeenCalledWith('/tmp/pixel.png');
    expect(resolved.format).toBe('png');
  });

  it('downloads HTTPS resources before validating their image bytes', async () => {
    const fetcher = jest.fn().mockResolvedValue(new Response(PNG, {
      status: 200,
      headers: { 'Content-Type': 'image/png' },
    }));

    const resolved = await resolveImageSource('https://example.test/pixel.png', {
      fetcher: fetcher as typeof fetch,
    });

    expect(fetcher).toHaveBeenCalledWith(new URL('https://example.test/pixel.png'), {
      redirect: 'follow',
    });
    expect(resolved.format).toBe('png');
  });

  it('rejects insecure remote URLs, malformed base64, and non-images', async () => {
    await expect(resolveImageSource('http://example.test/pixel.png'))
      .rejects.toThrow('must use HTTPS');
    await expect(resolveImageSource('not-a-path!', {
      readLocalFile: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' })),
    })).rejects.toThrow('valid base64');
    await expect(resolveImageSource(Buffer.from('plain text')))
      .rejects.toThrow('unsupported image data');
  });
});
