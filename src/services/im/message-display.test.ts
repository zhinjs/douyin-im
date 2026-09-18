import { isDesktopMessageDisplayable, isDesktopMessageVisible } from './message-display.js';
import type { PrivateMessage } from './types.js';

const message: PrivateMessage = { msgId: '0', threadId: '700', clientMessageId: 'client', senderUid: '22',
  content: '{"text":"body"}', msgType: 7, createTime: 0, status: 0 };

describe('Desktop message display gates', () => {
  it('separates native selection from the main-process empty-content projection gate', () => {
    const empty = { ...message, content: '' };
    expect(isDesktopMessageVisible(empty)).toBe(true);
    expect(isDesktopMessageDisplayable(empty)).toBe(false);
    expect(isDesktopMessageVisible({ ...empty, clientMessageId: '' })).toBe(false);
    expect(isDesktopMessageVisible({ ...empty, status: 1 })).toBe(false);
    expect(isDesktopMessageVisible({ ...empty, msgType: 50001 })).toBe(false);
    expect(isDesktopMessageVisible({ ...empty, msgType: 1002 })).toBe(true);
    expect(isDesktopMessageVisible({ ...empty, msgType: 1 })).toBe(true);
  });
  it.each([0, 7, 1001, 1002, 1999])('displays type %s without requiring server ID or send success', msgType => {
    expect(isDesktopMessageDisplayable({ ...message, msgType, status: 3, ext: { 's:invisible': '22', 's:is_recalled': 'true' }, deleted: true })).toBe(true);
  });
  it.each([-1, 2000, 40001, 50000, 50001])('rejects display type %s without changing storage classification', msgType => {
    expect(isDesktopMessageDisplayable({ ...message, msgType })).toBe(false);
  });
  it('uses canonical client identity, nonempty body and wire status, not local send state', () => {
    expect(isDesktopMessageDisplayable({ ...message, clientMessageId: '' })).toBe(false);
    expect(isDesktopMessageDisplayable({ ...message, ext: { 's:client_message_id': '' } })).toBe(false);
    expect(isDesktopMessageDisplayable({ ...message, content: '' })).toBe(false);
    expect(isDesktopMessageDisplayable({ ...message, status: 1 })).toBe(false);
    expect(isDesktopMessageDisplayable({ ...message, status: -1 })).toBe(true);
  });
  it.each([
    ['{"aweType":100200}', false],
    ['{"aweType":"100200"}', true],
    ['{"aweType":100200.0}', true],
    ['{"aweType":1.002e5}', true],
    ['{"awe_type":100200}', true],
    ['{"nested":{"aweType":100200}}', true],
    ['{"aweType":100200,"aweType":0}', true],
    ['{"aweType":0,"aweType":100200}', false],
    ['{"awe\\u0054ype":100200}', false],
    ['{"aweType":4295067496}', false],
    ['{"aweType":18446744073709551616}', true],
  ])('keeps native integer aweType semantics for %s', (content, expected) => {
    expect(isDesktopMessageDisplayable({ ...message, msgType: 1002, content })).toBe(expected);
  });
  it.each([
    [{}, '1.2.1', true],
    [{ pc_filter_min_version: '1.2.1' }, '1.2.1', false],
    [{ pc_filter_min_version: '1.2.2' }, '1.2.1', true],
    [{ pc_filter_max_version: '1.2.1' }, '1.2.1', false],
    [{ pc_filter_max_version: '1.2' }, '1.2.1', true],
    [{ pc_filter_max_version: '1.2.0' }, '1.2', false],
    [{ pc_filter_min_version: '1.0', pc_filter_max_version: '2.0' }, '3.0', false],
    [{ pc_filter_min_version: '3.0', pc_filter_max_version: '2.0' }, '1.0', true],
    [{ pc_filter_min_version: 1, pc_filter_max_version: null }, '1.2.1', true],
    [{ pc_filter_min_version: '1.10' }, '1.2', true],
  ] as const)('applies system-message version filter %j at %s', (body, version, expected) => {
    expect(isDesktopMessageDisplayable({ ...message, msgType: 1, content: JSON.stringify(body) }, version)).toBe(expected);
  });
});
