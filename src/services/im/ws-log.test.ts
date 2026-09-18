import { formatWsLogEvent } from './ws-log.js';

describe('Frontier WebSocket log formatting', () => {
  it('formats ignored non-protobuf frames without reading a response', () => {
    expect(formatWsLogEvent({
      kind: 'ignored',
      at: Date.UTC(2026, 0, 1),
      note: 'non-pb payload type=json len=50',
    })).toContain('IGNORED non-pb payload type=json len=50');
  });

  it('keeps malformed protobuf log events non-throwing', () => {
    expect(() => formatWsLogEvent({
      kind: 'protobuf',
      at: Date.UTC(2026, 0, 1),
      note: 'response unavailable',
    })).not.toThrow();
  });
});
