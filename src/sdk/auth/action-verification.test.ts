import { ActionVerification } from './action-verification.js';
import { ActionChallengeError } from '../../http/action-challenge.js';
import type { Account } from '../account.js';

describe('ActionVerification', () => {
  function fixture(source: 'bdturing' | 'passport-decision' = 'passport-decision') {
    const controller = { open: jest.fn().mockResolvedValue(undefined), complete: jest.fn(), cancel: jest.fn() };
    const account = { uid: '22' } as Account;
    const challenge = new ActionChallengeError(source, '{"detail":"private-token"}');
    const verification = new ActionVerification(account, { uid: '33', operation: 'follow' }, challenge, controller);
    return { verification, controller, account, challenge };
  }
  it('binds the account/target, hides platform secrets in ordinary serialization, and settles once', async () => {
    const { verification, controller, account, challenge } = fixture();
    expect(verification.account).toBe(account);
    expect(verification.decision).toEqual({ detail: 'private-token' });
    expect(JSON.stringify(verification)).not.toContain('private-token');
    expect(JSON.stringify(challenge)).not.toContain('private-token');
    await verification.complete({ status: true });
    await expect(verification.complete({ status: true })).rejects.toThrow('已结束');
    verification.cancel();
    expect(controller.complete).toHaveBeenCalledTimes(1);
    expect(controller.cancel).not.toHaveBeenCalled();
  });
  it('does not treat false/missing status as verification success', async () => {
    const { verification, controller } = fixture();
    await expect(verification.complete({ status: false })).rejects.toThrow('未确认');
    expect(controller.complete).not.toHaveBeenCalled();
    expect(controller.cancel).toHaveBeenCalledTimes(1);
  });
  it('deduplicates page opening and cancels on initialization failure', async () => {
    const { verification, controller } = fixture('bdturing');
    controller.open.mockRejectedValue(new Error('fixture failure'));
    const first = verification.open();
    expect(verification.open()).toBe(first);
    await expect(first).rejects.toThrow('fixture failure');
    expect(controller.open).toHaveBeenCalledTimes(1);
    expect(controller.cancel).toHaveBeenCalledTimes(1);
  });
  it.each(['not-json', 'null', '[]', '0'])('rejects malformed Passport decisions without reflecting them: %s', raw => {
    expect(() => new ActionChallengeError('passport-decision', raw)).toThrow('平台二次验证数据');
  });
});
