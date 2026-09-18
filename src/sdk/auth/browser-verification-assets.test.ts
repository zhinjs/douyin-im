import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiConnection } from '../../desktop/api-connection.js';
import { ActionChallengeError } from '../../http/action-challenge.js';
import type { Account } from '../account.js';
import { ActionVerification } from './action-verification.js';
import { LoginVerification } from './login-verification.js';

// Replace only package resolution. Production startup still reads real files,
// serves them over loopback and observes the verification object's lifetime.
const resolvePackage = jest.fn<string, [string]>();
// Jest 29 exposes this ESM hook at runtime, but @types/jest omits it.
const esmJest = jest as typeof jest & {
  unstable_mockModule(name: string, factory: () => unknown): void;
};
esmJest.unstable_mockModule('node:module', () => ({
  createRequire: () => ({ resolve: resolvePackage }),
}));
const { openBrowserVerification } = await import('./browser-verification.js');

let fixtureRoot: string;
beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'douyin-verification-assets-'));
});
afterEach(async () => {
  jest.restoreAllMocks();
  resolvePackage.mockReset();
  await rm(fixtureRoot, { recursive: true, force: true });
});

async function installFixture(project: string, missing?: string): Promise<void> {
  for (const name of ['react', 'react-dom']) {
    const root = join(fixtureRoot, project, 'node_modules', name);
    await mkdir(join(root, 'umd'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name }));
    if (missing !== name) {
      await writeFile(join(root, 'umd', `${name}.production.min.js`), `/* ${name}: 本地验证资源 */`);
    }
  }
  resolvePackage.mockImplementation(id => join(fixtureRoot, project, 'node_modules', id));
}

function challenge(kind: 'login' | 'action') {
  const controller = {
    open: async () => undefined,
    complete: async () => undefined,
    cancel: jest.fn(),
  };
  return kind === 'login'
    ? new LoginVerification({ source: 'qr-connect', operation: 'qr-connect', decision: { code: '10000' } }, controller)
    : new ActionVerification({ uid: 'fixture' } as Account, { operation: 'follow', uid: 'target' },
      new ActionChallengeError('bdturing', 'fixture-challenge'), controller);
}

it.each((['login', 'action'] as const).flatMap(kind =>
  ['ordinary', '中文 path', 'project#test', 'project%test', 'project%2Ftest'].map(project => ({ kind, project })),
))('loads $kind verification assets from literal path $project', async ({ kind, project }) => {
    await installFixture(project);
    const connection = new ApiConnection();
    const request = jest.spyOn(connection, 'requestVerificationRaw').mockResolvedValue({
      ok: true, status: 200, headers: new Headers(), data: '{}', rawText: '{}',
    });
    const verification = challenge(kind);
    let started!: (url: string) => void;
    const urlReady = new Promise<string>(resolve => { started = resolve; });
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(chunk => {
      const match = String(chunk).match(/浏览器打开: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
      if (match?.[1]) started(match[1]);
      return true;
    });
    const open = openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 });
    const ended = open.catch(() => undefined);
    try {
      const url = await Promise.race([urlReady, open.then(() => { throw new Error('Closed before startup'); })]);
      expect(await fetch(url).then(response => response.text())).toContain('window.__LOGIN_VERIFY__');
      for (const name of ['react', 'react-dom']) {
        const target = new URL(`/${name}.js`, url);
        target.search = new URL(url).search;
        const response = await fetch(target);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`/* ${name}: 本地验证资源 */`);
      }
      // No real Passport, account, certificate or follow request is dispatched.
      expect(request.mock.calls.every(([url]) => url.startsWith('https://vcs.zijieapi.com/vc/setting?'))).toBe(true);
    } finally {
      verification.cancel('fixture ended');
      await ended;
      write.mockRestore();
      request.mockRestore();
    }
});

it.each(['react', 'react-dom'])('reports an actually missing %s asset without starting a page', async name => {
  await installFixture('project#test', name);
  const connection = new ApiConnection();
  const request = jest.spyOn(connection, 'requestVerificationRaw');
  const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const verification = challenge('login');
  try {
    await expect(openBrowserVerification(verification, { connection }, { openBrowser: false, timeoutMs: 3000 }))
      .rejects.toThrow(join(fixtureRoot, 'project#test', 'node_modules', name, 'umd', `${name}.production.min.js`));
    expect(request).not.toHaveBeenCalled();
    expect(write.mock.calls.some(([chunk]) => String(chunk).includes('浏览器打开'))).toBe(false);
  } finally { verification.cancel('fixture ended'); }
});
