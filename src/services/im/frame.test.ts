import { decodeFrame, encodeFrame, encodeFrontierAck, frameHeader } from './frame.js';

describe('Frontier frame', () => {
  it('keeps uint64 identifiers exact and mirrors Desktop QoS ACK headers', async () => {
    const source = await encodeFrame({
      seqid: '9007199254740993',
      logid: '9007199254740995',
      service: 1,
      method: 1,
      headers: [{ key: 'need_ack', value: '1' }],
      logIdNew: 'new-log-id',
      payload: new Uint8Array([1, 2, 3]),
    });
    const decoded = await decodeFrame(source);

    expect(decoded.seqidString).toBe('9007199254740993');
    expect(decoded.logidString).toBe('9007199254740995');
    expect(frameHeader(decoded, 'need_ack')).toBe('1');

    const ackBytes = await encodeFrontierAck(decoded);
    const ack = await decodeFrame(ackBytes!);
    expect(ack.seqidString).toBe(decoded.seqidString);
    expect(ack.logidString).toBe(decoded.logidString);
    expect(ack.logIdNew).toBe('new-log-id');
    expect(ack.payload).toHaveLength(0);
    expect(Object.fromEntries(ack.headers.map((item) => [item.key, item.value]))).toEqual({
      is_ack: '1',
      ack_id: 'new-log-id',
      ack_code: '0',
    });
  });

  it('does not acknowledge an acknowledgement', async () => {
    const bytes = await encodeFrame({
      service: 1,
      method: 1,
      headers: [
        { key: 'need_ack', value: '1' },
        { key: 'is_ack', value: '1' },
      ],
    });
    expect(await encodeFrontierAck(await decodeFrame(bytes))).toBeUndefined();
  });
});
