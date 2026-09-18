import { calculateDesktopSortOrder, desktopCellSortTime, DESKTOP_PIN_OFFSET, isDesktopFloatMessage } from './conversation-float.js';
import { parseJsonWithBigInts } from '../../http/lossless-json.js';
import type { PrivateMessage } from './types.js';

const uid = '9007199254740993';
function message(content: string, msgType = 1001): PrivateMessage {
  return { msgId: '1', threadId: '700', senderUid: '2', content, msgType, createTime: 1, status: 0 };
}
const config = { enable: true, notHintMessages: {}, notFloatMessages: { 1001: [100110, 100118, 100113, 100140, 100101, 100102], 1: [0], 7: [-1] } };

describe('Desktop float and order rules', () => {
  it('allows by config first; -1 is a missing-aweType value, not a wildcard', () => {
    expect(isDesktopFloatMessage(message('{}', 7), uid)).toBe(true);
    expect(isDesktopFloatMessage(message('{}', 7), uid, config)).toBe(false);
    expect(isDesktopFloatMessage(message('{"aweType":1}', 7), uid, config)).toBe(true);
    expect(isDesktopFloatMessage(message('{"aweType":100110}'), uid, { ...config, enable: false })).toBe(true);
  });

  it.each([100110, 100140])('passive %i stops at the first object, even a missing/non-integer uid', aweType => {
    const test = (users: string) => isDesktopFloatMessage(message(`{"aweType":${aweType},"passive_users":${users}}`), uid, config);
    expect(test(`[null,[],false,{"uid":${uid}}]`)).toBe(true);
    for (const first of ['{}', '{"uid":3}', `{"uid":"${uid}"}`, `{"uid":${uid}.0}`]) {
      expect(test(`[${first},{"uid":${uid}}]`)).toBe(false);
    }
    expect(test(`[{"uid":${uid},"uid":2}]`)).toBe(false);
    expect(test(`[{"uid":2,"uid":${uid}}]`)).toBe(true);
  });

  it.each([100118, 100113, 100101, 100102])('active %i skips invalid uid types, but stops at the first integer', aweType => {
    const test = (users: string) => isDesktopFloatMessage(message(`{"aweType":${aweType},"active_users":${users}}`), uid, config);
    expect(test(`[null,{}, {"uid":"${uid}"},{"uid":1.0},{"uid":1e0},{"uid":18446744073709551616},{"uid":${uid}}]`)).toBe(true);
    expect(test(`[{"uid":3},{"uid":${uid}}]`)).toBe(false);
    expect(test(`[{"uid":${uid},"uid":3}]`)).toBe(false);
    expect(test(`[{"uid":${uid}}]`)).toBe(true);
    expect(test('[]')).toBe(false);
    expect(test('{}')).toBe(false);
  });

  it('requires the exact auto-create tip, message type and integer aweType', () => {
    const content = '{"aweType":0,"tips":"创建成功，快邀请你的粉丝进群吧！"}';
    expect(isDesktopFloatMessage(message(content, 1), uid, config)).toBe(true);
    expect(isDesktopFloatMessage(message(content.replace('！', '!'), 1), uid, config)).toBe(false);
    expect(isDesktopFloatMessage(message('{"aweType":0,"tips":true}', 1), uid, config)).toBe(false);
  });

  it('retains integer types and duplicate-key semantics without marker collisions', () => {
    expect(parseJsonWithBigInts('{"uid":1,"uid":18446744073709551615,"text":"__native_integer__42","float":42.0,"e":42e0}'))
      .toEqual({ uid: 18446744073709551615n, text: '__native_integer__42', float: 42, e: 42 });
    expect(() => parseJsonWithBigInts('{"uid":01}')).toThrow();
  });

  it('uses pinned offset or cell time, preserves max time and returns only sort changes', () => {
    const state = { lastMessageTime: 100, sortOrder: '5000' };
    expect(calculateDesktopSortOrder(state, 200, false, 5000n)).toBe(false);
    expect(state).toEqual({ lastMessageTime: 200, sortOrder: '5000' });
    expect(calculateDesktopSortOrder(state, -1, true, 9000n)).toBe(true);
    expect(state).toEqual({ lastMessageTime: 200, sortOrder: String(DESKTOP_PIN_OFFSET + 200) });
    expect(calculateDesktopSortOrder(state, DESKTOP_PIN_OFFSET + 1, false, 0n)).toBe(false);
    expect(state.lastMessageTime).toBe(200);
    expect(calculateDesktopSortOrder(state, DESKTOP_PIN_OFFSET, true, 0n)).toBe(true);
    expect(state.sortOrder).toBe(String(DESKTOP_PIN_OFFSET * 2));
    const negative = { lastMessageTime: -10, sortOrder: '0' };
    calculateDesktopSortOrder(negative, -5, true, 0n);
    expect(negative.sortOrder).toBe(String(DESKTOP_PIN_OFFSET - 5));
  });

  it.each([[undefined, 0n], ['', 0n], [' +12seconds', 12000n], ['1.8', 1000n], ['1e3', 1000n],
    ['0x10', 0n], ['-2', -2000n], ['wat', 0n], ['9223372036854775808', 0n], ['9223372036854775807', -1000n],
    ['-9223372036854775808', 0n], ['\u00a012', 0n]] as const)('converts native cell sort text %s', (text, expected) => {
    expect(desktopCellSortTime(text)).toBe(expected);
  });
});
