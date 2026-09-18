import { desktopTicketPolicy, filterTicketSessionConfig, ticketSessionPathMatches } from './ticket-guard-config.js';
import { DesktopTicketGuard } from './ticket-guard.js';

const FOLLOW = new URL('https://imdesktop.douyin.com/aweme/v1/web/commit/follow/user/');
const LOGIN = new URL('https://imdesktop.douyin.com/passport/web/check_qrconnect/');
const initial = { enable: true, ree_enable_symmetric: true, ree_path: [FOLLOW.pathname] };

it.each([undefined, false, null, 0, ''])('uses Main defaults for falsy remote config %s', config => {
  const policy = desktopTicketPolicy({ bdticket_config: config });
  expect(policy.enabled).toBe(true);
  expect(policy.session.ree_enable_symmetric).toBe(true);
  expect(ticketSessionPathMatches(policy.session, FOLLOW.pathname)).toBe(true);
});

it.each([{}, [], { session_guard_config: {} }, { session_guard_config: { enable: 'true', ree_path: 1 } }])('retains cached config after an empty filtered update, but stays disabled for cold config %j', config => {
  expect(desktopTicketPolicy({ bdticket_config: config }).session).toEqual({});
  expect(desktopTicketPolicy({ bdticket_config: config }, initial).session).toEqual(initial);
});

it.each([{ enable: false }, { enable: true }, { ree_path: [] }, { config_version: 'v2' }])('replaces rather than merges a nonempty filtered Session map %j', update => {
  const policy = desktopTicketPolicy({ bdticket_config: { session_guard_config: update } }, initial);
  expect(policy.session).toEqual(update);
  expect(ticketSessionPathMatches(policy.session, FOLLOW.pathname)).toBe(false);
});

it('filters native field types and isolates config snapshots from caller mutation', () => {
  const source = { ...initial, ree_path: [null, 42, FOLLOW.pathname, ''], ree_path_prefix: ['/api/', false],
    ree_exclude_path: [], ree_exclude_path_prefix: ['private', {}], config_version: 1, unsupported: true };
  const filtered = filterTicketSessionConfig(source);
  expect(filtered).toEqual({ enable: true, ree_enable_symmetric: true, ree_path: [FOLLOW.pathname, ''],
    ree_path_prefix: ['/api/'], ree_exclude_path: [], ree_exclude_path_prefix: ['private'] });
  source.ree_path[2] = '/changed/';
  expect(filtered.ree_path).toEqual([FOLLOW.pathname, '']);
});

it.each([false, 0, '', 'false', null])('only literal false disables the Main hook (%s)', value => {
  const policy = desktopTicketPolicy({ bdticket_switch: value });
  expect(policy.enabled).toBe(value !== false);
});

it.each([true, 'invalid', 1])('disables the hook for a wrapper-rejected truthy config %s', value => {
  expect(desktopTicketPolicy({ bdticket_config: value }, initial)).toEqual({ enabled: false, session: initial });
});

it('matches normalized request paths with exact and prefix exclusions before inclusions', () => {
  const config = { enable: true, ree_path: ['/exact/'], ree_path_prefix: ['', '/prefix'],
    ree_exclude_path: ['/prefix/exact/'], ree_exclude_path_prefix: ['', '/prefix/private'] };
  for (const path of ['/exact', '/exact/', '/prefix', '/prefix-more/', '/prefix/public/']) {
    expect(ticketSessionPathMatches(config, path)).toBe(true);
  }
  for (const path of ['/exact/extra/', '/Exact/', '/prefix/exact', '/prefix/private/anything', '/other/']) {
    expect(ticketSessionPathMatches(config, path)).toBe(false);
  }
  expect(ticketSessionPathMatches({ enable: true, ree_path: ['/exact'] }, '/exact')).toBe(false);
  expect(ticketSessionPathMatches({ enable: true, ree_path_prefix: [''] }, '/any')).toBe(false);
});

it('keeps Passport public-key headers independent of Session enable and uses symmetric only for serial headers', () => {
  const guard = new DesktopTicketGuard(undefined, { bdticket_config: { session_guard_config: { enable: false } } });
  expect(guard.prepare(LOGIN, '').headers).toHaveProperty('bd-ticket-guard-ree-public-key');
  expect(guard.prepare(LOGIN, '').headers).not.toHaveProperty('bd-ticket-guard-server-cert-sn');
  expect(guard.prepare(FOLLOW, 'session').headers).toEqual({});
  expect(guard.requiresTicket(FOLLOW)).toBe(false);
  const disabled = new DesktopTicketGuard(undefined, { bdticket_switch: false });
  expect(disabled.prepare(LOGIN, '').headers).toEqual({});
  expect(disabled.needsCertificate()).toBe(false);
});

it.each([
  [{ enable: false }, false],
  [{}, false],
  [{ ree_path: [FOLLOW.pathname] }, false],
  [{ enable: 'true' }, false],
  [{ enable: true }, true],
  [{ enable: true, ree_exclude_path_prefix: ['/passport/'] }, true],
] as const)('separates Passport public headers from Session binding eligibility (%j)', (sessionConfig, accepts) => {
  const guard = new DesktopTicketGuard(undefined, { bdticket_config: { session_guard_config: sessionConfig } });
  const request = guard.prepare(LOGIN, '');
  expect(request.headers['bd-ticket-guard-ree-public-key']).toBeTruthy();
  const headers = new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
    ticket: 'fixture-session', ts_sign_ree: 'fixture-signature',
  })).toString('base64') });
  expect(guard.acceptResponse(request, headers, 'fixture-session')).toBe(accepts);
  expect(guard.hasBinding('fixture-session')).toBe(accepts);
  expect(!!guard.exportState().binding).toBe(accepts);
});

it('keeps an old binding but does not replace it when Session guarding is switched off', () => {
  const active = new DesktopTicketGuard();
  const headers = (session: string) => new Headers({ 'bd-ticket-guard-server-data': Buffer.from(JSON.stringify({
    ticket: session, ts_sign_ree: `${session}-signature`,
  })).toString('base64') });
  active.acceptResponse(active.prepare(LOGIN, ''), headers('old-session'), 'old-session');
  const prior = active.exportState();
  const disabled = new DesktopTicketGuard(prior, { bdticket_config: { session_guard_config: { enable: false } } });
  const response = headers('new-session');
  response.set('bd-ticket-guard-client-cert', 'fixture-client-cert');
  // Certificate reception is independent of the Session associated flag.
  expect(disabled.acceptResponse(disabled.prepare(LOGIN, 'old-session'), response, 'new-session')).toBe(true);
  expect(disabled.exportState().binding).toEqual(prior.binding);
  expect(disabled.exportState().clientCert).toBe('fixture-client-cert');
  expect(disabled.hasBinding('new-session')).toBe(false);
});

it('restores the SDK config cache for an empty remote update and never broadens the allowed signing host', () => {
  const guard = new DesktopTicketGuard(undefined, { bdticket_config: { session_guard_config: initial } });
  const saved = guard.exportState();
  const restored = new DesktopTicketGuard(saved, { bdticket_config: {} });
  saved.sessionConfig!.ree_path!.length = 0;
  expect(restored.requiresTicket(FOLLOW)).toBe(true);
  expect(restored.requiresTicket(new URL(FOLLOW.toString().replace(/\/$/, '')))).toBe(true);
  expect(restored.prepare(new URL('https://example.com/passport/web/login/'), 'session').headers).toEqual({});
  expect(restored.prepare(new URL(FOLLOW.toString().replace('imdesktop.douyin.com', 'example.com')), 'session').headers).toEqual({});
});
