import { isMessageDelivered } from '../../services/im/service.js';
import type { SendMessageResponse } from '../../services/im/types.js';
import { getLogger, type Logger } from '../../logger.js';

export function logSendResult(
  res: SendMessageResponse,
  subject: string,
  brief: string,
  logger?: Logger,
): SendMessageResponse {
  const output = logger ?? getLogger('IM');
  if (!isMessageDelivered(res)) {
    output.error(
      'failed to send: %s %s(%s)%s',
      subject,
      res.statusMsg,
      res.statusCode,
      res.checkCode == null ? '' : ` check=${res.checkCode}`,
    );
  } else {
    output.info('succeed to send: %s %s', subject, brief);
    output.debug(
      'send receipt: %s client=%s server=%s check=%s',
      subject,
      res.clientMessageId || '-',
      res.serverMessageId || '-',
      res.checkCode ?? '-',
    );
  }
  return res;
}
