import { randomUUID } from 'node:crypto';
import type { Account } from '../account.js';
import type { ActionChallengeError } from '../../http/action-challenge.js';
import type { OpenLoginVerificationOptions } from './login-verification.js';

export interface ActionVerificationTarget {
  operation: 'follow' | 'unfollow';
  uid: string;
}

export interface ActionVerificationResult { status: boolean }

interface ActionVerificationController {
  open: (verification: ActionVerification, options: OpenLoginVerificationOptions) => Promise<void>;
  complete: () => void;
  cancel: (reason: string) => void;
}

/** A business challenge belongs to one account and one original action, never to login. */
export class ActionVerification {
  readonly id = randomUUID();
  readonly #challenge: ActionChallengeError;
  readonly #controller: ActionVerificationController;
  #settled = false;
  readonly #lifetime = new AbortController();
  #openTask?: Promise<void>;
  readonly target: Readonly<ActionVerificationTarget>;

  constructor(
    readonly account: Account,
    target: ActionVerificationTarget,
    challenge: ActionChallengeError,
    controller: ActionVerificationController,
  ) {
    this.target = Object.freeze({ ...target });
    this.#challenge = challenge;
    this.#controller = controller;
  }

  get source(): ActionChallengeError['source'] { return this.#challenge.source; }
  /** @internal Local verification host lifetime; null reason denotes completion. */
  get signal(): AbortSignal { return this.#lifetime.signal; }
  /** Sensitive: raw bdturing string, or passport decision JSON; do not log. */
  get raw(): string { return this.#challenge.raw; }
  get decision(): Readonly<Record<string, unknown>> {
    return this.source === 'passport-decision' ? JSON.parse(this.raw) as Record<string, unknown> : {};
  }

  open(options: OpenLoginVerificationOptions = {}): Promise<void> {
    if (this.#openTask) return this.#openTask;
    this.assertPending();
    const task = this.#controller.open(this, options).catch((error: unknown) => {
      this.cancel('业务验证页面未能完成');
      throw error;
    });
    this.#openTask = task;
    return task;
  }

  /** Submit only after the official component confirms success. No arbitrary request fields. */
  async complete(result: ActionVerificationResult): Promise<void> {
    this.assertPending();
    if (result?.status !== true) {
      this.cancel('平台未确认业务验证通过');
      throw new Error('平台未确认业务验证通过');
    }
    this.#settled = true;
    try {
      this.#controller.complete();
      this.#lifetime.abort(null);
    } catch (error) {
      this.#lifetime.abort(error);
      throw error;
    }
  }

  cancel(reason = '业务验证已取消'): void {
    if (this.#settled) return;
    this.#settled = true;
    this.#lifetime.abort(new Error(reason));
    this.#controller.cancel(reason);
  }

  private assertPending(): void {
    if (this.#settled) throw new Error('业务验证已结束');
  }
}
