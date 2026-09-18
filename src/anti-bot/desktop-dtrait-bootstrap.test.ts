import {
  DesktopDTraitBootstrap,
  type DesktopDTraitBootstrapContext,
  type DesktopDTraitScript,
} from './desktop-dtrait-bootstrap.js';
import { DesktopWebSecureSdk } from './desktop-web-secure-sdk.js';
import { DesktopPassportSecurePlugin } from './desktop-passport-secure-plugin.js';
import { webcrypto } from 'node:crypto';
import { DesktopWebSecureSystemCrypto } from './desktop-web-secure-crypto.js';

const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
function fixture() {
  const scripts: DesktopDTraitScript[] = [],
    calls: string[] = [];
  const core = {
    getInstance: jest.fn<
      unknown,
      [Record<string, unknown>, Record<string, unknown>]
    >(() => ({ synthetic: true })),
  };
  const monitor = {
    init: jest.fn(),
    setConfig: jest.fn(),
    setWebId: jest.fn(),
    sendSlardarEvent: jest.fn(),
    sendSlardarLog: jest.fn(),
    sendTeaLog: jest.fn(),
  };
  const context: DesktopDTraitBootstrapContext = {
    parameters: {
      window: {},
      XMLHttpRequest: class {
        readyState = 0;
        status = 0;
        response = '';
        onreadystatechange = null;
        open() {}
        setRequestHeader() {}
        send() {}
      },
      document: { cookie: '' },
      localStorage: {
        getItem: () =>
          btoa(
            JSON.stringify({
              urlVersion: '1.0.31',
              centralVersion: 'synthetic',
              createdTime: 100_000_000,
            })
          ),
        setItem() {},
        removeItem() {},
      },
      Date: { now: () => 100_000_000 },
      atob,
      btoa,
      setTimeout: () => 0,
    },
    window: { DTraitSDK: core },
    document: {
      createElement() {
        calls.push('create');
        return { type: '', src: '' };
      },
      getElementsByTagName() {
        return [
          {
            appendChild(script) {
              calls.push('append');
              scripts.push(script);
              expect(script.onload).toBeUndefined();
            },
          },
        ];
      },
    },
    monitor,
    performance: { now: () => 3 },
  };
  const bootstrap = new DesktopDTraitBootstrap(context);
  return { bootstrap, context, monitor, core, scripts, calls };
}

it('composes real cached parameter owner with loader and core, passing only core options', async () => {
  const f = fixture(),
    options = {
      aid: 6383,
      webId: 'synthetic',
      reportAppLog: false,
      consumerPathList: ['/path'],
      consumerHostList: ['host'],
      urlRewriteRules: [['a', 'b']],
      libraGroup: 'g',
      delayCollect: 3,
    };
  const result = f.bootstrap.start(options);
  await flush();
  expect(f.scripts[0]!.src).toBe(
    'https://lf-douyin-pc-web.douyinstatic.com/obj/passport-fe/ucenter_fe/@byted/uc-secure-dtrait-core/1.0.31/dist/index.umd.production.js'
  );
  expect(f.core.getInstance).not.toHaveBeenCalled();
  f.scripts[0]!.onload!();
  await expect(result).resolves.toEqual({ synthetic: true });
  expect(f.core.getInstance).toHaveBeenCalledWith(
    { urlVersion: '1.0.31', centralVersion: 'synthetic', dataFrom: 'local' },
    {
      dTraitPath: options.consumerPathList,
      dTraitHost: options.consumerHostList,
      urlRewriteRules: options.urlRewriteRules,
      containerSdkVersion: '1.0.23',
      libraGroup: 'g',
      delayCollect: 3,
      monitor: {
        sendSlardarEvent: f.monitor.sendSlardarEvent,
        sendSlardarLog: f.monitor.sendSlardarLog,
        sendTeaLog: f.monitor.sendTeaLog,
      },
    }
  );
  expect(f.monitor.init).toHaveBeenCalledWith(
    {
      appId: 6383,
      commonParams: { dTraitVersion: '1.0.23' },
      webId: 'synthetic',
      reportAppLog: false,
    },
    { slardarInstance: undefined, teaInstance: undefined }
  );
});

it.each([undefined, '6383'])(
  'uses non-Douyin CDN for raw aid %s even when parameter aid defaults',
  async aid => {
    const f = fixture(),
      result = f.bootstrap.start({ aid });
    await flush();
    expect(f.scripts[0]!.src).toContain('lf-ucenter-web.yhgfb-cn-static.com');
    f.scripts[0]!.onload!();
    await result;
  }
);

it('truthy core result skips subsequent loading but not parameter reads or core calls', async () => {
  const f = fixture(),
    reads = jest.spyOn(f.bootstrap.parameters, 'get'),
    first = f.bootstrap.start({});
  await flush();
  f.scripts[0]!.onload!();
  await first;
  await f.bootstrap.start({});
  expect(reads).toHaveBeenCalledTimes(2);
  expect(f.core.getInstance).toHaveBeenCalledTimes(2);
  expect(f.scripts).toHaveLength(1);
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledTimes(1);
});

it('falsy core result re-enters dynamic initialization but loader success is permanently memoized', async () => {
  const f = fixture();
  f.core.getInstance.mockReturnValue(undefined);
  const first = f.bootstrap.start({});
  await flush();
  f.scripts[0]!.onload!();
  await first;
  await f.bootstrap.start({});
  expect(f.scripts).toHaveLength(1);
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledTimes(2);
});

it('rejected core Promise remains truthy and does not force script reload', async () => {
  const f = fixture();
  f.core.getInstance.mockImplementationOnce(() =>
    Promise.reject(Error('core'))
  );
  const first = f.bootstrap.start({});
  await flush();
  f.scripts[0]!.onload!();
  await expect(first).rejects.toThrow('core');
  await f.bootstrap.start({});
  expect(f.scripts).toHaveLength(1);
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledTimes(1);
});

it('built-in mode skips parameter fetch and existing core skips loader, with exact public defaults', async () => {
  const f = fixture(),
    read = jest.spyOn(f.bootstrap.parameters, 'get');
  await f.bootstrap.start({ useBuildIn: true });
  expect(read).not.toHaveBeenCalled();
  expect(f.scripts).toHaveLength(0);
  const [params] = f.core.getInstance.mock.calls[0]!;
  expect(params).toEqual(
    expect.objectContaining({
      centralVersion: 'd0',
      edgeVersion: 'd0',
      dTraitVersion: '0',
      urlVersion: '1.0.31',
    })
  );
  expect(atob(params['centralRsaPub'] as string)).toContain(
    'BEGIN RSA PUBLIC KEY'
  );
  expect(f.monitor.setConfig).toHaveBeenCalledWith(
    expect.objectContaining({ useBuildIn: 1 })
  );
});

it('parameter failure falls back to built-ins and retains a visible diagnostic', async () => {
  const f = fixture();
  jest
    .spyOn(f.bootstrap.parameters, 'get')
    .mockRejectedValue(Error('parameter'));
  const result = f.bootstrap.start({});
  await flush();
  f.scripts[0]!.onload!();
  await result;
  expect(f.monitor.sendSlardarLog).toHaveBeenCalledWith({
    content: '[getDTraitParamsWithCache error]: Error: parameter',
  });
  expect(f.core.getInstance.mock.calls[0]![0]['centralVersion']).toBe('d0');
});

it('retries failed loading six times then still calls an already available core', async () => {
  const f = fixture(),
    result = f.bootstrap.start({});
  for (let i = 0; i < 6; i++) {
    await flush();
    f.scripts[i]!.onerror!(Error('script'));
  }
  await expect(result).resolves.toEqual({ synthetic: true });
  expect(f.scripts).toHaveLength(6);
  expect(f.monitor.sendSlardarEvent).toHaveBeenCalledWith(
    expect.objectContaining({
      categories: expect.objectContaining({ cdn_result: 0 }),
    })
  );
});

it('does not fake success if loading completed without a core', async () => {
  const f = fixture();
  delete f.context.window.DTraitSDK;
  const result = f.bootstrap.start({});
  await flush();
  f.scripts[0]!.onload!();
  await expect(result).rejects.toBeInstanceOf(TypeError);
});

it('built-in load failure retains initially empty parameters when a core appears meanwhile', async () => {
  const f = fixture();
  delete f.context.window.DTraitSDK;
  const result = f.bootstrap.start({ useBuildIn: true });
  for (let i = 0; i < 6; i++) {
    await flush();
    f.scripts[i]!.onerror!(Error('script'));
  }
  f.context.window.DTraitSDK = f.core;
  await result;
  expect(Object.values(f.core.getInstance.mock.calls[0]![0])).toEqual([
    '',
    '',
    '',
    '',
    '',
    '',
  ]);
});

it('supports module.default and readystatechange loaded without removing the script', async () => {
  const f = fixture();
  f.context.window.DTraitSDK = { default: f.core };
  const script = {
    type: '',
    src: '',
    readyState: 'loading',
    onreadystatechange: null as (() => void) | null,
  };
  f.context.document.createElement = () => script;
  const result = f.bootstrap.start({});
  await flush();
  script.onreadystatechange!();
  expect(f.core.getInstance).not.toHaveBeenCalled();
  script.readyState = 'loaded';
  script.onreadystatechange!();
  await result;
  expect(script.onreadystatechange).toBeNull();
  expect(f.scripts).toHaveLength(1);
});

it('coalesces concurrent loader calls, without coalescing startup/core calls', async () => {
  const f = fixture();
  f.monitor.sendSlardarEvent.mockImplementation(() => {
    f.calls.push('metric');
  });
  f.core.getInstance.mockImplementation(() => {
    f.calls.push('core');
    return true;
  });
  const a = f.bootstrap.start({ aid: 6383 }),
    b = f.bootstrap.start({ aid: 1 });
  await flush();
  expect(f.scripts).toHaveLength(1);
  f.scripts[0]!.onload!();
  await Promise.all([a, b]);
  expect(f.core.getInstance).toHaveBeenCalledTimes(2);
  expect(f.calls.slice(-4)).toEqual(['metric', 'metric', 'core', 'core']);
});

it('connects Passport -> actual Uo -> actual bootstrap/parameter cache -> synthetic core', async () => {
  const f = fixture();
  class Xhr {
    open() {}
    send() {}
    setRequestHeader() {}
  }
  const window = Object.assign(f.context.window, {
    XMLHttpRequest: Xhr,
    Request,
    Headers,
    Promise,
    fetch: async () => ({ headers: new Headers() }),
  });
  const sdk = new DesktopWebSecureSdk({
    keys: {
      Date,
      crypto: new DesktopWebSecureSystemCrypto(webcrypto.subtle),
      certificates: { get: async () => ({ cert: '', sn: '' }) },
    },
    document: { cookie: '', location: { hostname: 'synthetic.invalid' } },
    browser: { window, navigator: { userAgent: 'TTElectron' } },
    transport: {
      window,
      XMLHttpRequest: Xhr,
      Request,
      Headers,
      URL,
      location: { href: 'https://synthetic.invalid/' },
    },
    tcc: { getConfig: async () => undefined },
    dtrait: f.bootstrap,
  });
  // This test isolates the login/DTrait connection; real Keys/P-256 composition is covered in the owner suite.
  const keysStart = jest
    .spyOn(sdk.cryptoSDK, 'start')
    .mockImplementation(() => {});
  sdk.disableTccConfig(true);
  const events: unknown[] = [];
  sdk.on('init', event => {
    events.push(event);
  });
  const plugin = new DesktopPassportSecurePlugin(
    { realm: window, sdk, getCookie: () => 'synthetic-csrf' },
    { aid: 6383 }
  );
  try {
    plugin.init();
    await flush();
    expect(events).toEqual([{ type: 'bdTicket' }]);
    expect(f.monitor.setWebId).toHaveBeenCalledWith('synthetic-csrf');
    f.scripts[0]!.onload!();
    await flush();
    expect(events).toEqual([{ type: 'bdTicket' }, { type: 'dtrait' }]);
    expect(f.core.getInstance.mock.calls[0]![1]['dTraitPath']).toEqual([
      '/passport',
      '/quick_login/v2',
      '/check_qrconnect',
      '/account_login/v2',
      '/one_login',
    ]);
    expect(f.monitor.init.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ webId: 'synthetic-csrf' })
    );
  } finally {
    keysStart.mockRestore();
  }
});
