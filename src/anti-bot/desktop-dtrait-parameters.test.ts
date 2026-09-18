import {
  DesktopDTraitParameters,
  DESKTOP_DTRAIT_PARAMETERS_KEY as KEY,
  type DesktopDTraitParametersContext,
} from './desktop-dtrait-parameters.js';

const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
const data = {
  'x-tt-session-dtrait-pk1': 'synthetic-central',
  'x-tt-session-dtrait-pk1-version': 'c1',
  'x-tt-session-dtrait-pk2': 'synthetic-edge',
  'x-tt-session-dtrait-pk2-version': 'e1',
  'x-tt-session-dtrait-fe-url-version': '1.0.31',
  'x-tt-session-dtrait-version': '0',
};
function fixture() {
  const calls: unknown[][] = [],
    requests: Xhr[] = [],
    timers: (() => void)[] = [];
  let cached: string | null = null,
    now = 100_000_000;
  class Xhr {
    readyState = 0;
    status = 0;
    response: unknown = '';
    onreadystatechange: (() => void) | null = null;
    constructor() {
      requests.push(this);
    }
    open(...args: [string, string]) {
      calls.push(['open', ...args]);
    }
    setRequestHeader(...args: [string, string]) {
      calls.push(['header', ...args]);
    }
    send(body: string) {
      calls.push(['send', body]);
    }
    respond(value: unknown, status = 200) {
      this.readyState = 4;
      this.status = status;
      this.response = JSON.stringify(value);
      this.onreadystatechange?.();
    }
  }
  const document = { cookie: 'passport_csrf_token_default=synthetic%2Bcsrf' };
  const context: DesktopDTraitParametersContext = {
    document,
    window: { XMLHttpRequest: Xhr, FormData: true },
    XMLHttpRequest: Xhr,
    localStorage: {
      getItem(key) {
        calls.push(['get', key]);
        return cached;
      },
      setItem(key, value) {
        calls.push(['set', key, value]);
        cached = value;
      },
      removeItem(key) {
        calls.push(['remove', key]);
        cached = null;
      },
    },
    atob,
    btoa,
    Date: { now: () => now },
    setTimeout(callback, delay) {
      calls.push(['timer', delay]);
      timers.push(callback);
    },
  };
  return {
    api: new DesktopDTraitParameters(context),
    context,
    document,
    calls,
    requests,
    timers,
    cache(value: unknown) {
      cached = btoa(JSON.stringify(value));
    },
    raw(value: string) {
      cached = value;
    },
    now(value: number) {
      now = value;
    },
    stored() {
      return cached ? JSON.parse(atob(cached)) : null;
    },
    success(index = 0) {
      requests[index]!.respond({ message: 'success', data });
    },
  };
}

it('uses trait URL/CSRF/form and maps six fields into a base64 cache at response time', async () => {
  const f = fixture(),
    result = f.api.get(6383);
  expect(f.calls).toEqual([
    ['get', KEY],
    ['remove', KEY],
    ['timer', 3000],
    [
      'open',
      'POST',
      '/passport/ticket_guard/get_client_cert/?aid=6383&type=trait&sdk_version=1.0.23&is_from_ttaccountsdk=1',
    ],
    ['header', 'Content-Type', 'application/x-www-form-urlencoded'],
    ['header', 'Accept', 'application/json'],
    ['header', 'x-tt-passport-csrf-token', 'synthetic+csrf'],
    ['send', 'server_data=1&need_session_dtrait=1'],
  ]);
  f.now(100_000_021);
  f.success();
  const value = await result;
  expect(value).toEqual({
    centralRsaPub: 'synthetic-central',
    centralVersion: 'c1',
    edgeRsaPub: 'synthetic-edge',
    edgeVersion: 'e1',
    urlVersion: '1.0.31',
    dTraitVersion: '0',
    dataFrom: 'remote',
  });
  const { dataFrom: _, ...fields } = value;
  void _;
  expect(f.stored()).toEqual({ ...fields, createdTime: 100_000_021 });
  f.timers[0]!();
  await flush();
});

it('merges concurrent calls across aid/cache flags but not across independent instances', async () => {
  const f = fixture(),
    g = fixture(),
    first = f.api.get(1);
  expect(f.api.get(2, false)).toBe(first);
  const separate = g.api.get(2);
  expect(separate).not.toBe(first);
  f.success();
  g.success();
  await Promise.all([first, separate]);
  await flush();
  const later = f.api.get(3, false);
  expect(later).not.toBe(first);
  f.success(1);
  await later;
});

it('preserves arbitrary cache fields, allows missing mandatory fields, and replaces dataFrom', async () => {
  const f = fixture();
  f.cache({ createdTime: 100_000_000, extra: false, dataFrom: 'wrong' });
  await expect(f.api.get(1)).resolves.toEqual({
    extra: false,
    dataFrom: 'local',
  });
  await flush();
  f.cache({ createdTime: 100_000_000 });
  await expect(f.api.get(2)).resolves.toEqual({ dataFrom: 'local' });
  expect(f.requests).toHaveLength(0);
});

it.each([null, ''])(
  'invalidates cache containing an empty own field (%s)',
  async value => {
    const f = fixture();
    f.cache({ createdTime: 100_000_000, extra: value });
    const result = f.api.get(1);
    f.success();
    await result;
    expect(f.requests).toHaveLength(1);
  }
);

it.each([
  'not base64',
  btoa('{'),
  btoa('null'),
  btoa('{"createdTime":13600000}'),
  btoa('{"centralVersion":"c"}'),
])(
  'falls back from corrupt/expired cache %# without failing the request',
  async raw => {
    const f = fixture();
    f.raw(raw);
    const result = f.api.get(1);
    f.success();
    await result;
    expect(f.calls).toContainEqual(['remove', KEY]);
  }
);

it('retains string timestamp concatenation and strict TTL boundary', async () => {
  const f = fixture();
  f.cache({ createdTime: '1', centralVersion: 'old' });
  await expect(f.api.get(1)).resolves.toEqual({
    centralVersion: 'old',
    dataFrom: 'local',
  });
  expect(f.requests).toHaveLength(0);
});

it.each(['getItem', 'removeItem', 'setItem', 'btoa'] as const)(
  'ignores %s failure without losing remote result',
  async method => {
    const f = fixture();
    const fail = () => {
      throw Error('storage');
    };
    if (method === 'btoa') f.context.btoa = fail;
    else f.context.localStorage[method] = fail;
    const result = f.api.get(1);
    f.success();
    await expect(result).resolves.toEqual(
      expect.objectContaining({ dataFrom: 'remote' })
    );
  }
);

it('cache bypass skips reading/removal but still writes the remote result', async () => {
  const f = fixture();
  f.raw('{');
  const result = f.api.get(1, false);
  f.success();
  await result;
  expect(f.calls.some(call => call[0] === 'get' || call[0] === 'remove')).toBe(
    false
  );
  expect(f.stored()).not.toBeNull();
});

it.each([{}, null, undefined])(
  'preserves source weak acceptance of empty data %#, not trusted certificate readiness',
  async value => {
    const f = fixture(),
      result = f.api.get(1);
    f.requests[0]!.respond({ message: 'success', data: value });
    await expect(result).resolves.toEqual({
      dataFrom: 'remote',
      centralRsaPub: undefined,
      centralVersion: undefined,
      edgeRsaPub: undefined,
      edgeVersion: undefined,
      urlVersion: undefined,
      dTraitVersion: undefined,
    });
    expect(f.stored()).toEqual({ createdTime: 100_000_000 });
  }
);

it('rejects empty unrelated response fields and does not cache', async () => {
  const f = fixture(),
    result = f.api.get(1);
  f.requests[0]!.respond({
    message: 'success',
    data: { ...data, unrelated: '' },
  });
  await expect(result).rejects.toThrow('get empty cert');
  expect(f.stored()).toBeNull();
});

it('does not abort a timed-out request or let its late success populate cache', async () => {
  const f = fixture(),
    first = f.api.get(1);
  f.timers[0]!();
  await expect(first).rejects.toThrow('get cert timeout');
  await flush();
  const next = f.api.get(2);
  f.success();
  await flush();
  expect(f.stored()).toBeNull();
  f.success(1);
  await next;
});

it.each([0, 199, 300, 500, NaN])(
  'leaves HTTP %s pending until the outer timer',
  async status => {
    const f = fixture(),
      result = f.api.get(1);
    f.requests[0]!.respond({ message: 'success', data }, status);
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await flush();
    expect(settled).toBe(false);
    f.timers[0]!();
    await expect(result).rejects.toThrow('get cert timeout');
  }
);

it('uses first CSRF match and rejects malformed URI before send', async () => {
  const f = fixture();
  f.document.cookie = 'passport_csrf_token=first; passport_csrf_token=second';
  const first = f.api.get(1);
  expect(f.calls).toContainEqual([
    'header',
    'x-tt-passport-csrf-token',
    'first',
  ]);
  f.success();
  await first;
  await flush();
  f.document.cookie = 'passport_csrf_token=%ZZ';
  await expect(f.api.get(1, false)).rejects.toBeInstanceOf(URIError);
  expect(f.calls.filter(call => call[0] === 'send')).toHaveLength(1);
});

it('does not substitute native requests when FormData is absent', async () => {
  const f = fixture();
  delete (f.context.window as { FormData?: unknown }).FormData;
  await expect(f.api.get(1)).rejects.toThrow('not support XMLHttpRequest');
  expect(f.requests).toHaveLength(0);
});
