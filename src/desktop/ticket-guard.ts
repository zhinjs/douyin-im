import {
  createECDH, createHash, createHmac, createPrivateKey, diffieHellman,
  hkdfSync, sign, X509Certificate, type KeyObject,
} from 'node:crypto';
import { DESKTOP_APP_VERSION } from './constants.js';
import type { DesktopApplicationSettings } from './settings.js';
import { desktopTicketPolicy, ticketSessionPathMatches, type TicketGuardSessionConfig } from './ticket-guard-config.js';
const PREFIX = 'bd-ticket-guard-';

/** Internal sensitive state: persist with the account's Session, never log. */
export interface DesktopTicketGuardState {
  version: 1;
  privateKey: string;
  clientCert?: string;
  serverCert?: string;
  serverSn?: string;
  /** Cached Session selection; an empty signature is retained but is not ready for follow. */
  binding?: { sessionHash: string; tsSignRee: string };
  /** Native-equivalent filtered Session config; never merged with a partial replacement. */
  sessionConfig?: TicketGuardSessionConfig;
}

export interface TicketGuardRequest {
  readonly headers: Readonly<Record<string, string>>;
  /** Native associated diagnostic; never sent as an HTTP header or used as server success. */
  readonly useTicketErrorCode?: 4;
}

/**
 * Desktop PC REE protocol. No native dependency, shared singleton or network I/O.
 * This is not a claim that a newly generated key is bound to an existing Session.
 */
export class DesktopTicketGuard {
  readonly #privateKey: KeyObject;
  readonly #privateScalar: string;
  readonly #publicKey: string;
  readonly #requests = new WeakMap<TicketGuardRequest, { eligible: boolean; bindSession: boolean }>();
  #clientCert = '';
  #serverCert = '';
  #serverSn = '';
  #hmacKey?: Buffer;
  #binding?: DesktopTicketGuardState['binding'];
  readonly #policy: ReturnType<typeof desktopTicketPolicy>;

  constructor(state?: DesktopTicketGuardState, settings?: DesktopApplicationSettings) {
    if (state && state.version !== 1) throw new Error('Unsupported Desktop ticket guard state');
    this.#policy = desktopTicketPolicy(settings, state?.sessionConfig);
    const ec = createECDH('prime256v1');
    if (state) {
      const scalar = decodeBase64(state.privateKey);
      if (scalar.length !== 32) throw new Error('Invalid Desktop ticket guard key');
      ec.setPrivateKey(scalar);
    } else ec.generateKeys();
    const point = ec.getPublicKey(undefined, 'uncompressed');
    // OpenSSL may omit leading zero octets; stored P-256 scalars/JWK d are 32 bytes.
    const scalar = Buffer.alloc(32);
    const rawScalar = ec.getPrivateKey();
    rawScalar.copy(scalar, 32 - rawScalar.length);
    this.#privateScalar = scalar.toString('base64');
    this.#publicKey = point.toString('base64');
    this.#privateKey = createPrivateKey({
      format: 'jwk',
      key: {
        kty: 'EC', crv: 'P-256',
        d: scalar.toString('base64url'),
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      },
    });
    if (state) {
      this.updateCertificates(state.clientCert ?? '', state.serverCert ?? '', state.serverSn ?? '');
      if (state.binding) {
        if (!/^[a-f0-9]{64}$/.test(state.binding.sessionHash) || typeof state.binding.tsSignRee !== 'string') {
          throw new Error('Invalid Desktop ticket binding');
        }
        this.#binding = { ...state.binding };
      }
    }
  }

  /** Explicit sensitive export; private fields are hidden from ordinary logging. */
  exportState(): DesktopTicketGuardState {
    return {
      version: 1, privateKey: this.#privateScalar,
      sessionConfig: structuredClone(this.#policy.session),
      ...(this.#clientCert ? { clientCert: this.#clientCert } : {}),
      ...(this.#serverCert ? { serverCert: this.#serverCert } : {}),
      ...(this.#serverSn ? { serverSn: this.#serverSn } : {}),
      ...(this.#binding ? { binding: { ...this.#binding } } : {}),
    };
  }

  hasBinding(sessionId: string): boolean {
    return !!this.#binding?.tsSignRee && this.matchesCachedSession(sessionId);
  }

  private matchesCachedSession(sessionId: string): boolean {
    return !!sessionId && this.#binding?.sessionHash === sessionHash(sessionId);
  }

  /** Native load_cached_cert tests server and serial presence, not client cert or expiry. */
  needsCertificate(): boolean {
    return this.#policy.enabled && (!this.#serverCert || !this.#serverSn);
  }

  requiresTicket(url: URL): boolean {
    return this.eligible(url) && ticketSessionPathMatches(this.#policy.session, url.pathname);
  }

  private eligible(url: URL): boolean {
    // Native hooks arbitrary hosts. The multi-account SDK deliberately does not
    // disclose account ticket material outside its authorized HTTPS Desktop host.
    return this.#policy.enabled && url.protocol === 'https:' && url.hostname === 'imdesktop.douyin.com';
  }

  /** CertLoader consumes response.data.cert, server_cert, server_sn. */
  acceptCertificateResponse(response: unknown): void {
    const outer = record(response);
    const data = record(outer?.['data']);
    if (outer?.['message'] !== 'success' || !data) throw new Error('Desktop certificate request failed');
    const client = string(data['cert']);
    const server = string(data['server_cert']);
    const sn = string(data['server_sn']);
    // CertLoader can receive these fields separately; empty fields preserve prior values.
    this.updateCertificates(Buffer.from(client).toString('base64'), server, sn);
  }

  prepare(url: URL, sessionId: string, sessionSS = '', timestamp = Math.floor(Date.now() / 1000), symmetric = this.#policy.session.ree_enable_symmetric === true): TicketGuardRequest {
    const headers: Record<string, string> = {};
    const eligible = this.eligible(url);
    const getTicket = eligible && url.pathname.startsWith('/passport/');
    const useTicket = this.requiresTicket(url) && !!(sessionId || sessionSS);
    if (getTicket || useTicket) {
      headers[`${PREFIX}version`] = '2';
      headers[`${PREFIX}iteration-version`] = '2';
      headers[`${PREFIX}ree-public-key`] = this.#publicKey;
      if (getTicket && symmetric) headers[`${PREFIX}server-cert-sn`] = this.#serverSn || '0';
    }
    if (useTicket) {
      // Native compares the cached ticket to SessionId first. A cold binding is
      // an empty ticket, so it matches an empty SessionId even if SS is present.
      const primaryMatches = this.#binding ? this.matchesCachedSession(sessionId) : sessionId === '';
      const ticket = primaryMatches ? sessionId : sessionSS;
      const content = ticketSignContent(ticket, url.pathname, timestamp);
      if (symmetric && !this.#hmacKey && this.#serverCert) this.#hmacKey = this.deriveHmacKey(this.#serverCert);
      const hmac = symmetric && this.#hmacKey;
      const signature = hmac
        ? createHmac('sha256', hmac).update(content).digest('base64')
        : sign('sha256', Buffer.from(content), { key: this.#privateKey, dsaEncoding: 'der' }).toString('base64');
      if (hmac) headers[`${PREFIX}iteration-version`] = '3';
      // Native nlohmann JSON emits keys in lexical order. timestamp is a number.
      headers[`${PREFIX}client-data`] = Buffer.from(JSON.stringify({
        req_content: 'ticket,path,timestamp', req_sign_ree: signature, timestamp,
        // Native carries the cached signature even after a Cookie mismatch.
        // Business preflight must check binding separately; a header is not proof.
        ts_sign_ree: this.#binding?.tsSignRee ?? '',
      })).toString('base64');
    }
    const request: TicketGuardRequest = { headers: Object.freeze(headers),
      ...(useTicket && !this.#binding?.tsSignRee ? { useTicketErrorCode: 4 as const } : {}),
    };
    // Native adds Passport public headers before testing SessionGuardConfig.enable.
    // Only the latter installs the associated flag authorizing response binding.
    this.#requests.set(request, { eligible, bindSession: getTicket && this.#policy.session.enable === true });
    return request;
  }

  /** newSessionId is from this response's Set-Cookie, never the latest global jar. */
  acceptResponse(request: TicketGuardRequest, headers: Headers, newSessionId: string): boolean {
    const context = this.#requests.get(request);
    this.#requests.delete(request);
    if (!context?.eligible) return false;
    let changed = false;
    const encoded = headers.get(`${PREFIX}server-data`);
    if (context.bindSession && encoded && encoded.length <= 65_536 && newSessionId) {
      try {
        const data = record(JSON.parse(decodeBase64(encoded).toString('utf8')));
        const items = Array.isArray(data?.['tickets']) ? data['tickets'] : [data];
        for (const item of items) {
          const ticket = record(item);
          if (ticket?.['ticket'] === newSessionId) {
            // Native replaces the entire matching item, including its default/empty
            // REE signature. Keeping the old signature would falsely retain readiness.
            this.#binding = { sessionHash: sessionHash(newSessionId), tsSignRee: string(ticket['ts_sign_ree']) };
            changed = true;
          }
        }
      } catch { /* Native ignores malformed server-data; never manufacture a ticket. */ }
    }
    const client = headers.get(`${PREFIX}client-cert`) ?? '';
    const server = headers.get(`${PREFIX}server-cert`) ?? '';
    if (client || server) {
      this.updateCertificates(client, server, '');
      changed = true;
    }
    return changed;
  }

  private updateCertificates(client: string, server: string, sn: string): void {
    if (client.startsWith('-----')) throw new Error('Desktop client certificate must be Base64 encoded');
    // Native update_client_cert stores client first; invalid server data does not roll it back.
    if (client) this.#clientCert = client;
    let pem = server;
    let derived: Buffer | undefined;
    if (pem) {
      if (!pem.startsWith('-----')) pem = decodeBase64(pem).toString('utf8');
      if (!pem.startsWith('-----BEGIN CERTIFICATE-----')) throw new Error('Invalid Desktop server certificate');
      derived = this.deriveHmacKey(pem);
    }
    if (pem && derived) {
      this.#serverCert = pem;
      // Native CertManager persists a replacement cert, but preload_ecdh_key_async
      // calls ecdh_key's existing cache without invalidation. A new guard derives
      // from the latest persisted cert; never serialize the old derived key.
      if (this.#policy.session.ree_enable_symmetric === true) this.#hmacKey ??= derived;
    }
    if (sn) this.#serverSn = sn;
  }

  private deriveHmacKey(pem: string): Buffer {
    const publicKey = new X509Certificate(pem).publicKey;
    if (publicKey.asymmetricKeyType !== 'ec' || publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Desktop server certificate must use P-256');
    }
    const shared = diffieHellman({ privateKey: this.#privateKey, publicKey });
    return Buffer.from(hkdfSync('sha256', shared, Buffer.alloc(0), Buffer.alloc(0), 32));
  }
}

export function ticketSignContent(ticket: string, path: string, timestamp: number): string {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) throw new Error('Ticket guard requires a pathname');
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('Invalid ticket guard timestamp');
  return `ticket=${ticket}&path=${path.endsWith('/') ? path : `${path}/`}&timestamp=${timestamp}`;
}

/** Cert requests bypass account Cookie/signing interceptors, as in Desktop main. */
export function desktopCertificateRequest(deviceId: string, installId: string): { url: string; init: RequestInit } {
  const query = new URLSearchParams({
    aid: '339757', is_from_ttaccountsdk: '1', device_id: deviceId, iid: installId,
    version_code: DESKTOP_APP_VERSION, device_platform: 'PC',
  });
  return {
    url: `https://imdesktop.douyin.com/passport/ticket_guard/get_client_cert/?${query}`,
    init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'server_data=1' },
  };
}

function sessionHash(session: string): string {
  return createHash('sha256').update(session).digest('hex');
}
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid ticket guard Base64');
  }
  return Buffer.from(value, 'base64');
}
