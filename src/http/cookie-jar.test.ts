import { CookieJar } from './cookie-jar.js';
import { ApiConnection } from '../desktop/api-connection.js';

describe('response Cookie synchronization', () => {
  afterEach(() => jest.restoreAllMocks());

  it('separates combined cookies while preserving Expires commas and encoded values', () => {
    const jar = new CookieJar('msToken=old; sessionid=old-session');
    jar.mergeSetCookie('msToken=new==; Path=/; Expires=Wed, 09 Jun 2038 10:18:14 GMT, sessionid=new-session; HttpOnly');
    expect(jar.get('msToken')).toBe('new==');
    expect(jar.get('sessionid')).toBe('new-session');
    expect(jar.toHeader()).toBe('msToken=new==; sessionid=new-session');
  });

  it('deletes expired cookies and applies Max-Age precedence over Expires', () => {
    const jar = new CookieJar('first=1; second=2; third=3');
    jar.mergeSetCookie('first=deleted; Max-Age=0; Expires=Wed, 09 Jun 2038 10:18:14 GMT');
    jar.mergeSetCookie('second=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    jar.mergeSetCookie('third=updated; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    expect(jar.toHeader()).toBe('third=updated');
  });

  it('rotates and deletes Cookie tokens without changing the explicit signing override', async () => {
    const fetcher = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Set-Cookie': 'msToken=rotated; Path=/' } }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'Set-Cookie': 'msToken=; Max-Age=0' } }));
    const client = new ApiConnection({ msToken: 'initial', initialCookies: 'sessionid=test' });
    await client.requestRaw('https://example.test/test', { method: 'GET' });
    expect(client.jar.get('msToken')).toBe('rotated');
    expect(client.signExtrasForPath().msToken).toBe('initial');
    await client.requestRaw('https://example.test/test', { method: 'GET' });
    expect((fetcher.mock.calls[1]?.[1]?.headers as Record<string, string>)['Cookie']).toContain('msToken=rotated');
    expect(client.jar.get('msToken')).toBeUndefined();
    expect(client.signExtrasForPath().msToken).toBe('initial');
  });

  it('keeps Set-Cookie and explicit token updates without importing a report header', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', {
      headers: { 'Set-Cookie': 'msToken=cookie-value', 'x-ms-token': 'header-value' },
    }));
    const client = new ApiConnection();
    await client.requestRaw('https://example.test/test', { method: 'GET' });
    expect(client.getMsToken()).toBeUndefined();
    expect(client.jar.get('msToken')).toBe('cookie-value');
    client.setMsToken('manual');
    expect(client.jar.get('msToken')).toBe('cookie-value');
    client.jar.merge('msToken=restored');
    expect(client.getMsToken()).toBe('manual');
    expect(client.jar.get('msToken')).toBe('restored');
  });
});
