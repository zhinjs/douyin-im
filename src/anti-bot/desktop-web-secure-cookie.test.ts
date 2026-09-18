import { createHash } from 'node:crypto';
import { createDesktopWebSecureCookieDigest, readDesktopWebSecureCookie, verifyDesktopWebSecureCookie, DesktopWebSecureCookieOperator, desktopWebSecureCookieDomain } from './desktop-web-secure-cookie.js';

it.each(['key', '中文😀', '\ud800', 'x'.repeat(56), 'x'.repeat(64), 'x'.repeat(3000)])('matches MD5 of ordered JSON for %s', publicKey => {
  const key = JSON.stringify({ ec_publicKey: publicKey }), cert = { content: 'synthetic' }, serverData = 'data\u0000😀';
  const expected = createHash('md5').update(JSON.stringify({ publicKey, cert, serverData })).digest('hex');
  expect(createDesktopWebSecureCookieDigest(key, cert, serverData)).toBe(expected);
  expect(verifyDesktopWebSecureCookie(expected, key, cert, serverData)).toBe(true); expect(verifyDesktopWebSecureCookie(expected.toUpperCase(), key, cert, serverData)).toBe(false);
});

it('checks truthiness and JSON structure, not PEM validity or certificate type', () => {
  expect(createDesktopWebSecureCookieDigest('{}', 'cert', 'data')).toBe(''); expect(createDesktopWebSecureCookieDigest('broken', 'cert', 'data')).toBe('');
  expect(createDesktopWebSecureCookieDigest('{"ec_publicKey":false}', 'cert', 'data')).toBe(''); expect(createDesktopWebSecureCookieDigest('{"ec_publicKey":23}', { any: 'object' }, 'data')).not.toBe('');
  expect(verifyDesktopWebSecureCookie('', '{}', 'cert', 'data')).toBe(false);
});

it('returns empty on unserializable metadata and mismatched digest', () => {
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  expect(createDesktopWebSecureCookieDigest('{"ec_publicKey":"key"}', cyclic, 'data')).toBe('');
  expect(createDesktopWebSecureCookieDigest('{"ec_publicKey":"key"}', 1n, 'data')).toBe('');
  expect(verifyDesktopWebSecureCookie('bad', '{"ec_publicKey":"key"}', 'cert', 'data')).toBe(false);
});

it('reads the first nonempty exact name, URI decodes, and leaves plus intact', () => {
  expect(readDesktopWebSecureCookie(() => 'name_extra=no; name=; name=some%20value+a; name=later', 'name')).toBe('some value+a');
  expect(readDesktopWebSecureCookie(() => 'name=%zz; name=later', 'name')).toBe('');
  expect(readDesktopWebSecureCookie(() => { throw Error('denied'); }, 'name')).toBe('');
});

it('mr regex getter does not skip an empty first cookie like He does', () => {
  const document = { cookie: 'x=; x=last', location: { hostname: 'synthetic.invalid' } }, cookie = new DesktopWebSecureCookieOperator(document);
  expect(cookie.getCookie('x')).toBeNull(); expect(readDesktopWebSecureCookie(() => document.cookie, 'x')).toBe('last');
});

it('mr setter encodes name/value and truthy attributes, convenience setters return void', () => {
  const document = { cookie: '', location: { hostname: 'app.synthetic.invalid' } }, cookie = new DesktopWebSecureCookieOperator(document);
  expect(cookie.setCookie('a b', 'x+y', '/', 'synthetic.invalid', 0, true)).toBe(true); expect(document.cookie).toBe('a%20b=x%2By; domain=synthetic.invalid; path=/; secure');
  expect(cookie.setCookie('Domain', 'bad')).toBe(false); expect(cookie.setCookieWithMaxAge('x', 'y')).toBeUndefined(); expect(document.cookie).toBe('x=y; max-age=5184000; path=/');
});

it('mr emits get/set failures, but has/delete/key listing errors are synchronous', () => {
  const document = { get cookie(): string { throw Error('read'); }, set cookie(_value: string) { throw Error('write'); }, location: { hostname: '' } };
  const cookie = new DesktopWebSecureCookieOperator(document), errors = jest.fn(); cookie.on('error', errors);
  expect(cookie.getCookie('x')).toBeNull(); expect(cookie.setCookie('x', 'y')).toBe(false); expect(errors.mock.calls.map(call => call[0].name)).toEqual(['cookie get item error', 'cookie set item error']);
  expect(() => cookie.hasCookie('x')).toThrow('read'); expect(() => cookie.deleteCookie('x')).toThrow('read'); expect(() => cookie.getCookieKeys()).toThrow('read');
});

it('mr deletes domain, hostname, then host-only, each conditioned on hasCookie', () => {
  const writes: string[] = [], document = { get cookie() { return 'x=value'; }, set cookie(value: string) { writes.push(value); }, location: { hostname: 'app.synthetic.invalid' } };
  new DesktopWebSecureCookieOperator(document).deleteAllCookie('x');
  expect(writes).toEqual(['x=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=synthetic.invalid; path=/', 'x=; expires=Thu, 01 Jan 1970 00:00:00 UTC; domain=app.synthetic.invalid; path=/', 'x=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/']);
});

it('domain helper preserves native IP and single-label quirks', () => {
  expect(desktopWebSecureCookieDomain(() => '127.0.0.1')).toBe('0.0.1'); expect(desktopWebSecureCookieDomain(() => 'internal')).toBe('.internal');
  expect(desktopWebSecureCookieDomain(() => 'app.site.co.uk')).toBe('co.uk'); expect(desktopWebSecureCookieDomain(() => '')).toBe('.');
});
