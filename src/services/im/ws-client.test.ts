import protobuf from 'protobufjs';
import { decodeResponseRaw } from './codec.js';
import { pushFromResponse } from './ws-client.js';

describe('Frontier message notifications', () => {
  it('decodes Desktop cmd 504 as the native flat P2P payload', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const ResponseEnvelope = root.lookupType('im_proto.Response');
    const bytes = ResponseEnvelope.encode(ResponseEnvelope.create({
      cmd: 504,
      inboxType: 1,
      body: {
        hasNewP2pMessageNotify: {
          sendType: 1,
          sender: '3138463854771706',
          secSender: 'MS4wLjABAAAApeer',
          conversationId: '0:1:1150530166719210:3138463854771706',
          conversationShortId: '9007199254740995',
          conversationType: 1,
          messageType: 7,
          content: '{"text":"hello"}',
          ext: { source: 'desktop' },
          createTime: '1789091200000',
        },
      },
    })).finish();

    const decoded = await decodeResponseRaw(bytes);
    expect(pushFromResponse(504, decoded)).toMatchObject({
      cmd: 504,
      conversationId: '0:1:1150530166719210:3138463854771706',
      conversationShortId: '9007199254740995',
      conversationType: 1,
      senderUid: '3138463854771706',
      senderSecUid: 'MS4wLjABAAAApeer',
      messageType: 7,
      content: '{"text":"hello"}',
      createTime: '1789091200000',
      ext: { source: 'desktop' },
    });
  });

  it('decodes native field 503 from cmd 1099 and maps it as a stranger message', async () => {
    const root = await protobuf.load('src/services/im/proto/im.proto');
    const ResponseEnvelope = root.lookupType('im_proto.Response');
    const bytes = ResponseEnvelope.encode(ResponseEnvelope.create({
      cmd: 1099,
      inboxType: 1,
      body: {
        strangerHasNewMessageNotify: {
          message: {
            conversationId: '0:1:1150530166719210:3138463854771706',
            conversationType: 1,
            conversationShortId: '9007199254740995',
            serverMessageId: '9007199254740997',
            sender: '3138463854771706',
            secSender: 'MS4wLjABAAAApeer',
            content: '{"text":"hello"}',
            messageType: 7,
            ext: { 's:client_message_id': 'client-1' },
            version: '2',
            status: 0,
            orderInConversation: '30',
            referenceInfo: {
              referencedMessageId: '9007199254740996',
              hint: '{"content":"source"}',
              refMessageType: 7,
              referencedMessageStatus: 0,
              rootMessageId: '9007199254740996',
              rootMessageConvIndex: '30',
            },
            indexInConversation: '31',
            indexInConversationV2: '32',
          },
        },
      },
    })).finish();

    const decoded = await decodeResponseRaw(bytes);
    expect(pushFromResponse(1099, decoded)).toMatchObject({
      cmd: 1099,
      inboxType: 1,
      conversationId: '0:1:1150530166719210:3138463854771706',
      conversationShortId: '9007199254740995',
      conversationType: 1,
      senderUid: '3138463854771706',
      senderSecUid: 'MS4wLjABAAAApeer',
      serverMessageId: '9007199254740997',
      clientMessageId: 'client-1',
      version: '2',
      orderInConversation: '30',
      ext: { 's:client_message_id': 'client-1' },
      referenceInfo: {
        refMessageId: '9007199254740996',
        refMessageType: 7,
        rootMessageConvIndex: '30',
      },
      indexInConversation: '31',
      indexInConversationV2: '32',
    });
  });
});
