import { ImWebSocketReceiver } from './frontier-websocket.js';
import { FrontierImWs, type ImPushMessage } from '../../../services/im/ws-client.js';

afterEach(() => jest.restoreAllMocks());

it('keeps unused cmd502 available on raw without claiming a cached conversation update', async () => {
  jest.spyOn(FrontierImWs.prototype, 'connect').mockResolvedValue(undefined);
  const onRaw = jest.fn();
  const onNotice = jest.fn();
  const onInbound = jest.fn();
  const receiver = new ImWebSocketReceiver({ deviceId: 'device', cookies: '', onInbound, onRaw, onNotice });
  await receiver.start();
  const response = { cmd: 502, body: { conversationInfoUpdatedNotify: {
    conversation: { conversationId: '700', conversationType: 2 },
  } } };
  receiver.frontierWs!.emit('protobuf', response);
  expect(onRaw).toHaveBeenCalledWith(502, response);
  expect(onNotice).not.toHaveBeenCalled();
  expect(onInbound).not.toHaveBeenCalled();
  await receiver.stop();
});

it('passes repeated, self and empty-content ordinary messages to the account merge boundary', async () => {
  jest.spyOn(FrontierImWs.prototype, 'connect').mockResolvedValue(undefined);
  const onInbound = jest.fn();
  const receiver = new ImWebSocketReceiver({ deviceId: 'device', cookies: '', onInbound });
  await receiver.start();
  const push: ImPushMessage = { cmd: 500, conversationId: '700', conversationShortId: '700', conversationType: 2,
    senderUid: '10', content: '{"text":"self"}', messageType: 7, serverMessageId: '99', raw: {} };
  receiver.frontierWs!.emit('message', push);
  receiver.frontierWs!.emit('message', { ...push, senderUid: '20', version: '2' });
  receiver.frontierWs!.emit('message', { ...push, senderUid: '20', content: '', version: '3' });
  expect(onInbound).toHaveBeenCalledTimes(3);
  expect(onInbound.mock.calls[2]![0]).toMatchObject({ serverMessageId: '99', rawContent: '', version: '3' });
  await receiver.stop();
});
