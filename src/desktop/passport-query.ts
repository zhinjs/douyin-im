import {
  generateABogus,
  generateDesktopABogus,
  generateJumpbyteABogus,
  type DesktopABogusOptions,
  type BdmsPreset,
} from '../anti-bot/aBogus.js';
import { buildPassportSignQs } from '../passport/signQs.js';

export interface SignedPassportQuery {
  query: Record<string, string>;
  search: string;
}

export function randomBizTraceId(): string {
  // C321 _l.getUUID / C92 Tl: eight hex digits, generated once by the trace owner.
  // This is a correlation ID, not a cryptographic token.
  let timestamp = Date.now();
  let monotonic = typeof performance !== 'undefined' && performance.now ? 1000 * performance.now() : 0;
  return 'xxxxxxxx'.replace(/x/g, () => {
    let digit = 16 * Math.random();
    if (timestamp > 0) {
      digit = (timestamp + digit) % 16 | 0;
      timestamp = Math.floor(timestamp / 16);
    } else {
      digit = (monotonic + digit) % 16 | 0;
      monotonic = Math.floor(monotonic / 16);
    }
    return digit.toString(16);
  });
}

export interface SignPassportExtras {
  /** Passport SDK appKey。 */
  appKey?: string;
  msToken?: string;
  /** 手动覆盖时跳过本地计算 */
  aBogus?: string;
  userAgent?: string;
  enableABogus?: boolean;
  /** POST 的 on-wire form（`encodeFormBody`）；GET 传 '' */
  bodyWire?: string;
  screenFingerprint?: string;
  bdmsPreset?: BdmsPreset;
  aBogusVariant?: 'jumpbyte-desktop';
  /** Explicit originating BDMS .7 state selects its core; never inferred from UA or legacy screen presets. */
  desktopBdmsState?: Omit<DesktopABogusOptions, 'query' | 'body' | 'userAgent'>;
}

export function signPassportQuery(
  baseQuery: Record<string, string>,
  body: Record<string, string> = {},
  extras?: SignPassportExtras,
): SignedPassportQuery {
  const signInput: Parameters<typeof buildPassportSignQs>[0] = {
    query: baseQuery,
    body,
  };
  if (extras?.appKey) signInput.appKey = extras.appKey;
  const { sign, qs } = buildPassportSignQs(signInput);
  return finishPassportQuery({ ...baseQuery, sign, qs }, extras);
}

/** C321 $u.show replays existing sign/qs; El strips isResend before BDMS hooks the new XHR. */
export function resumePassportQuery(
  signedQuery: Readonly<Record<string, string>>,
  fp?: string,
  extras?: SignPassportExtras,
): SignedPassportQuery {
  const query: Record<string, string> = { ...signedQuery, ...(fp ? { fp, verifyFp: fp } : {}) };
  delete query['isResend'];
  return finishPassportQuery(query, extras);
}

function finishPassportQuery(signedQuery: Record<string, string>, extras?: SignPassportExtras): SignedPassportQuery {
  const query = { ...signedQuery };
  if (extras?.msToken) {
    query['msToken'] = extras.msToken;
  }

  const manualAbogus = extras?.aBogus;
  const compute =
    !manualAbogus &&
    extras?.enableABogus !== false &&
    Boolean(extras?.userAgent);

  if (manualAbogus) {
    query['a_bogus'] = manualAbogus;
  } else if (compute) {
    // Axios constructs the initial URL. BDMS then parses it as URL and hashes
    // searchParams.toString(), not the pre-hook Axios spelling (e.g. ':'/'~').
    const queryForAbogus = new URLSearchParams(encodePassportQuery(query)).toString();
    const abOpts: Parameters<typeof generateABogus>[0] = {
      userAgent: extras!.userAgent!,
      query: queryForAbogus,
      body: extras?.bodyWire ?? '',
    };
    if (extras?.screenFingerprint) {
      abOpts.screenFingerprint = extras.screenFingerprint;
    }
    if (extras?.bdmsPreset) {
      abOpts.bdmsPreset = extras.bdmsPreset;
    }
    query['a_bogus'] = extras?.desktopBdmsState
      ? generateDesktopABogus({
          ...extras.desktopBdmsState,
          userAgent: abOpts.userAgent,
          query: abOpts.query,
          body: abOpts.body ?? '',
        })
      : extras?.aBogusVariant === 'jumpbyte-desktop'
      ? generateJumpbyteABogus({
          userAgent: abOpts.userAgent,
          query: abOpts.query,
          body: abOpts.body ?? '',
        })
      : generateABogus(abOpts);
  }

  // Appending a_bogus through URL.searchParams also canonicalizes the final URL.
  // Manual override / disabled signing bypass this local hook simulation.
  const search = compute ? new URLSearchParams(query).toString() : encodePassportQuery(query);
  return { query, search };
}

/** Normal Account SDK's bundled Axios buildURL encoding, before browser URL parsing. */
function encodePassportQuery(query: Record<string, string>): string {
  const encode = (value: string): string => encodeURIComponent(value)
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+')
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']');
  return Object.entries(query).map(([key, value]) => `${encode(key)}=${encode(value)}`).join('&');
}

export function encodeFormBody(body: Record<string, string>): string {
  return Object.keys(body)
    .map((key) => {
      const value = body[key] ?? '';
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
}
