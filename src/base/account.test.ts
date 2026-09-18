import { BaseAccount } from './account.js';

class TestAccount extends BaseAccount {
  readonly uid = 'platform-1';
  readonly imUid = 'im-1';
  starts = 0;
  stops = 0;
  cancels = 0;
  private pendingGeneration?: number;

  finishLogin(): void {
    if (this.pendingGeneration === undefined) throw new Error('login has not started');
    this.assertLoginGeneration(this.pendingGeneration);
    this.completeLogin();
  }

  reconnecting(): void {
    this.setAccountState('reconnecting');
  }

  runContinuation(action: () => Promise<void>): Promise<void> {
    return this.continueLoginAction(action);
  }

  protected override async beginLogin(generation: number): Promise<void> {
    this.starts += 1;
    this.pendingGeneration = generation;
  }

  protected override cancelLogin(): void {
    this.cancels += 1;
  }

  protected override async stopRuntime(): Promise<void> {
    this.stops += 1;
  }
}

describe('BaseAccount lifecycle interface', () => {
  it('reuses login and logout tasks while exposing an immutable identity snapshot', async () => {
    const account = new TestAccount();
    const first = account.login();
    const second = account.login();

    expect(first).toBe(second);
    expect(account.starts).toBe(1);
    expect(account.state).toBe('logging-in');
    expect(account.identity).toEqual({ platformUid: 'platform-1', imUid: 'im-1' });

    account.finishLogin();
    await first;
    expect(account.online).toBe(true);

    account.reconnecting();
    expect(account.online).toBe(true);

    const logout = account.logout();
    expect(account.logout()).toBe(logout);
    await logout;
    expect(account.state).toBe('offline');
    expect(account.stops).toBe(1);
    expect(account.cancels).toBe(1);
  });

  it('rejects a pending login when logout cancels its generation', async () => {
    const account = new TestAccount();
    const login = account.login();
    const rejected = expect(login).rejects.toThrow('登录已取消');

    await account.logout();
    await rejected;

    expect(account.state).toBe('offline');
    expect(() => account.finishLogin()).toThrow('登录已取消');
  });

  it.each(['startup', 'continuation'] as const)('ignores a stale %s failure after a new login starts', async source => {
    const account = new TestAccount();
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => { reject = fail; });
    const begin = jest.spyOn(account as unknown as { beginLogin(generation: number): Promise<void> }, 'beginLogin');
    if (source === 'startup') begin.mockImplementationOnce(() => pending);
    const first = account.login(); const cancelled = expect(first).rejects.toThrow('登录已取消');
    const continuation = source === 'continuation' ? account.runContinuation(() => pending) : undefined;
    const failedContinuation = continuation ? expect(continuation).rejects.toThrow('old failure') : undefined;
    await account.logout(); await cancelled;
    const second = account.login();
    // Attach an observer so the pre-fix rejected second login is not unhandled.
    const observed = second.catch(() => undefined);
    reject(new Error('old failure'));
    await failedContinuation;
    for (let step = 0; step < 3; step++) await Promise.resolve();
    try {
      expect(account.state).toBe('logging-in');
      account.finishLogin();
      await second;
    } finally { await account.logout(); await observed; }
  });
});
