import type { EmojiContentOptions, ReplyMessageOptions } from '../../services/im/content.js';
import type { CardMessage, FileAsset, LinkCard, UserCard, WorkCard } from '../../services/im/cards.js';
import type { ImageInput } from './media-source.js';
import type { TextMention } from '../../services/im/content.js';

export type { ImageInput, ImageSource } from './media-source.js';
export { isImageAsset } from './media-source.js';

export interface TextMessageSegment {
  type: 'text';
  text: string;
}

export interface AtMessageSegment {
  type: 'at';
  uid: string;
  name: string;
}

export type SendableText = string | TextMessageSegment | AtMessageSegment;

export type RichMessage =
  | CardMessage
  | { type: 'file-upload'; data: Uint8Array; name: string }
  | { type: 'image'; data: ImageInput }
  | { type: 'video'; data: Uint8Array; cover: Uint8Array; width?: number; height?: number }
  | ({ type: 'emoji' } & EmojiContentOptions)
  | { type: 'sticker'; sticker: Readonly<Record<string, unknown>> }
  | ({ type: 'reply' } & ReplyMessageOptions);

export type SendableMessage = SendableText | readonly SendableText[] | RichMessage;

export interface PreparedTextMessage {
  text: string;
  mentions: TextMention[];
}

function isTextSegment(item: unknown): item is SendableText {
  if (typeof item === 'string') return true;
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  const type = (item as { type?: unknown }).type;
  return type === 'text' || type === 'at';
}

export function isTextMessage(message: SendableMessage): message is SendableText | readonly SendableText[] {
  return Array.isArray(message) ? message.every(isTextSegment) : isTextSegment(message);
}

export function prepareTextMessage(
  message: SendableText | readonly SendableText[],
): PreparedTextMessage {
  const segments = Array.isArray(message) ? message : [message];
  let text = '';
  const mentions: TextMention[] = [];
  for (const item of segments as readonly SendableText[]) {
    if (typeof item === 'string') {
      text += item;
      continue;
    }
    if (item.type === 'text') {
      text += item.text;
      continue;
    }
    const label = `@${item.name}`;
    mentions.push({ uid: item.uid, text: label, location: text.length, length: label.length });
    text += label;
  }
  return { text, mentions };
}

/** 生成与 oicq `brief` 相同用途的单行日志摘要，不展开二进制或协议载荷。 */
export function messageBrief(message: SendableMessage): string {
  if (isTextMessage(message)) return oneLine(prepareTextMessage(message).text);
  switch (message.type) {
    case 'group-invite': return `[群邀请] ${oneLine(message.group.name ?? message.group.groupId)}`;
    case 'image': return '[图片]';
    case 'video': return '[视频]';
    case 'emoji': return `[表情] ${oneLine(message.displayName ?? message.url)}`.trim();
    case 'sticker': return '[收藏表情]';
    case 'file-upload': return `[文件] ${message.name}`;
    case 'file': return `[文件] ${message.file.name}`;
    case 'share': return `[分享作品] ${message.work.title || message.work.itemId}`;
    case 'photos': return `[图集] ${message.work.title || message.work.itemId}`;
    case 'link': return `[链接] ${message.link.title || message.link.url}`;
    case 'user': return `[名片] ${message.user.name || message.user.uid}`;
    case 'reply': return `[回复] ${oneLine(message.text)}`;
  }
}

function oneLine(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

/** oicq 风格消息段构造器。 */
export const segment = {
  text(text: string): TextMessageSegment { return { type: 'text', text }; },
  at(
    target: string | { uid: string; displayName?: string | undefined; nickname?: string | undefined },
    name?: string,
  ): AtMessageSegment {
    const uid = typeof target === 'string' ? target : target.uid;
    const resolvedName = name ?? (typeof target === 'string' ? undefined : target.displayName ?? target.nickname) ?? uid;
    if (!/^\d+$/.test(uid)) throw new Error('mention uid must be a numeric IM uid');
    if (!resolvedName.trim()) throw new Error('mention name is required');
    return { type: 'at', uid, name: resolvedName };
  },
  share(work: WorkCard): SendableMessage { return { type: 'share', work }; },
  photos(work: WorkCard): SendableMessage { return { type: 'photos', work }; },
  link(link: LinkCard): SendableMessage { return { type: 'link', link }; },
  user(user: UserCard): SendableMessage { return { type: 'user', user }; },
  file(file: FileAsset | Uint8Array, name?: string): SendableMessage {
    if (file instanceof Uint8Array) {
      if (!name?.trim()) throw new Error('file name is required');
      return { type: 'file-upload', data: file, name };
    }
    return { type: 'file', file };
  },
  image(data: ImageInput): SendableMessage {
    return { type: 'image', data };
  },
  video(data: Uint8Array, cover: Uint8Array, options: { width?: number; height?: number } = {}): SendableMessage {
    return { type: 'video', data, cover, ...options };
  },
  emoji(options: EmojiContentOptions): SendableMessage {
    return { type: 'emoji', ...options };
  },
  /** Pass a record from getCollectedEmojis or a confirmed collection's successItems. */
  sticker(sticker: Readonly<Record<string, unknown>>): SendableMessage {
    return { type: 'sticker', sticker };
  },
  reply(options: ReplyMessageOptions): SendableMessage {
    return { type: 'reply', ...options };
  },
};
