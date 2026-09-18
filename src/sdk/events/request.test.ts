import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Client } from '../client.js';
import { GroupJoinRequestStatus } from '../../services/im/types.js';
import type { ImActionResponse } from '../../services/im/types.js';
import { RequestEvent } from './request.js';

describe('group request inherited decisions', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'douyin-im-request-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  function fixture() {
    const account = new Client({ dataDir, autoLoad: false }).createAccount();
    const review = jest.fn<Promise<ImActionResponse>, [unknown]>();
    Object.defineProperty(account, 'im', {
      value: { reviewGroupJoinRequest: review },
    });
    const group = account.bindGroup('70001');
    const time = '2026-09-09T00:00:00.000Z';
    const request = group.ensureJoinRequest({
      requestId: '9001', applicantUid: '22', groupShortId: '70001',
      conversationType: 2, status: GroupJoinRequestStatus.PENDING, createdAt: time,
    });
    return { request, review, group, time };
  }

  it('inherits public decisions and submits concurrent approvals only once', async () => {
    const { request, review, group, time } = fixture();
    let finish!: (response: ImActionResponse) => void;
    review.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    expect(request.approve).toBe(RequestEvent.prototype.approve);
    expect(request.reject).toBe(RequestEvent.prototype.reject);
    expect(request.time).toBe(Date.parse(time) / 1000);

    const first = request.approve();
    expect(request.approve()).toBe(first);
    await expect(request.reject()).rejects.toThrow('不能同时');
    expect(review).toHaveBeenCalledTimes(1);
    expect(request.isPending).toBe(true);
    finish({ statusCode: 0, statusMsg: '' });
    await first;

    expect(request.isPending).toBe(false);
    await expect(request.approve()).rejects.toThrow('已处理');
    await expect(request.reject()).rejects.toThrow('已处理');
    expect(review).toHaveBeenCalledTimes(1);
    // An approved request is not yet evidence that the applicant joined.
    expect(group.pickMember('22')).toBeUndefined();
  });

  it('deduplicates rejection and keeps rejected applicants out of group members', async () => {
    const { request, review, group } = fixture();
    review.mockResolvedValue({ statusCode: 0, statusMsg: '' });
    const first = request.reject();
    expect(request.reject()).toBe(first);
    await expect(request.approve()).rejects.toThrow('不能同时');
    await first;
    expect(request.isPending).toBe(false);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ status: 3 }));
    expect(group.pickMember('22')).toBeUndefined();
  });

  it('releases the in-flight guard on explicit failure without updating business state', async () => {
    const { request, review, group } = fixture();
    review.mockResolvedValueOnce({ statusCode: 3, statusMsg: 'rejected' })
      .mockRejectedValueOnce(new Error('connection failed'))
      .mockResolvedValueOnce({ statusCode: 0, statusMsg: '' });
    await expect(request.approve()).resolves.toMatchObject({ statusCode: 3 });
    expect(request.isPending).toBe(true);
    expect(group.pickMember('22')).toBeUndefined();
    await expect(request.reject()).rejects.toThrow('connection failed');
    expect(request.isPending).toBe(true);
    // No automatic retry: a new explicit call is required.
    expect(review).toHaveBeenCalledTimes(2);
    await request.reject();
    expect(request.isPending).toBe(false);
  });
});
