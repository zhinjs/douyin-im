import { decodeFrame, encodeFrame } from './frame.js';
import { FrontierCursors, decodeCursors, encodeCursors } from './frontier-cursors.js';

describe('Desktop Frontier cursor protocol', () => {
  it('round trips the native cursor record without losing uint64 precision', () => {
    // Reserved zero byte, service uint32 BE, UTF-8 name length byte, name, uint64 BE.
    const bytes = Buffer.from('000000000103696d31ffffffffffffffff', 'hex');
    const cursors = [{ service: 1, name: 'im1', value: '18446744073709551615' }];
    expect(decodeCursors(bytes)).toEqual(cursors);
    expect(encodeCursors(cursors)).toEqual(bytes);
  });

  it('answers first-login cursor requests and resumes the persisted namespace', async () => {
    const saved = new Map<string, ReturnType<typeof decodeCursors>>();
    const store = {
      getFrontierCursors: (key: string) => saved.get(key),
      setFrontierCursors: (key: string, value: ReturnType<typeof decodeCursors>) => { saved.set(key, value); },
    };
    const request = await decodeFrame(await encodeFrame({
      service: 0, method: 5, frameType: 16,
      headers: [{ key: 'cursor_file_name', value: 'cursor-test' }], payloadType: '',
    }));
    const session = new FrontierCursors('device-1', store);
    const response = await session.control(request);
    expect(await decodeFrame(response.reply!)).toMatchObject({
      service: 9000, method: 5, frameType: 32,
      headers: [{ key: 'cursor_file_name', value: 'FILE_NOT_EXIST' }],
    });
    const entries = [{ service: 1, name: 'im1', value: '9007199254740993' }];
    await session.control(await decodeFrame(await encodeFrame({
      service: 9000, method: 6, frameType: 32,
      headers: request.headers, payload: encodeCursors(entries), payloadType: '',
    })));
    const restored = new FrontierCursors('device-1', store);
    const resumed = await restored.control(request);
    const frame = await decodeFrame(resumed.reply!);
    expect(frame.headers).toEqual(request.headers);
    expect(decodeCursors(frame.payload)).toEqual(entries);
    // Another device must not reuse this cursor file.
    const other = await new FrontierCursors('device-2', store).control(request);
    expect((await decodeFrame(other.reply!)).headers[0]?.value).toBe('FILE_NOT_EXIST');
  });

  it('rejects truncated cursor data and overlong names', () => {
    expect(() => decodeCursors(Buffer.from([17, 0, 0]))).toThrow();
    expect(() => encodeCursors([{ service: 1, name: 'x'.repeat(256), value: '1' }])).toThrow();
  });

  it('advances only committed QoS messages and refuses malformed batches atomically', async () => {
    const session = new FrontierCursors('device');
    const headers = [{ key: 'cursor_file_name', value: 'file' }];
    await session.control(await decodeFrame(await encodeFrame({ service: 9000, method: 5, frameType: 16, headers })));
    const message = await decodeFrame(await encodeFrame({ service: 1, method: 1, headers: [
      { key: 'x-msg-qos', value: '2' }, { key: 'x-msg-cursor_name', value: 'im1' },
      { key: 'x-msg-cursor_value', value: '9007199254740993' },
    ] }));
    expect(session.isDuplicate(message)).toBe(false);
    // A failed decoder does not call commit, so redelivery remains eligible.
    expect(session.isDuplicate(message)).toBe(false);
    session.commit(message);
    expect(session.isDuplicate(message)).toBe(true);
    const broken = Buffer.concat([encodeCursors([{ service: 1, name: 'im1', value: '9999999999999999' }]), Buffer.from([1])]);
    await expect(session.control(await decodeFrame(await encodeFrame({ service: 9000, method: 6, frameType: 32, headers, payload: broken })))).rejects.toThrow();
    const restored = await session.control(await decodeFrame(await encodeFrame({ service: 9000, method: 5, frameType: 16, headers })));
    expect(decodeCursors((await decodeFrame(restored.reply!)).payload)[0]?.value).toBe('9007199254740993');
  });
});
