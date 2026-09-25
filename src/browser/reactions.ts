/** Signed reaction operations for browser rooms. Fixed emoji set; one per member per emoji per message. */

export const REACTION_EMOJI = ['👍', '❤️', '😂', '👀', '🎉'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];

export type ReactionBody = {
  kind: 'reaction';
  roomId: string;
  id: string;
  deviceId: string;
  memberId: string;
  messageId: string;
  emoji: ReactionEmoji;
  at: number;
  removed?: true;
};

export type ReactionPacket = { body: ReactionBody; signature: string };

/** One visible chip: who reacted with this emoji on a message. */
export type ReactionChip = {
  messageId: string;
  emoji: ReactionEmoji;
  memberIds: string[];
};

const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const isDevice = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function isReactionEmoji(value: unknown): value is ReactionEmoji {
  return typeof value === 'string' && (REACTION_EMOJI as readonly string[]).includes(value);
}

export function validReactionBody(body: unknown, roomId: string): body is ReactionBody {
  if (!body || typeof body !== 'object') return false;
  const b = body as ReactionBody;
  return b.kind === 'reaction'
    && b.roomId === roomId
    && isId(b.id)
    && isDevice(b.deviceId)
    && isId(b.memberId)
    && isId(b.messageId)
    && isReactionEmoji(b.emoji)
    && Number.isSafeInteger(b.at) && b.at > 0
    && (b.removed === undefined || b.removed === true);
}

/** Latest op wins per (messageId, memberId, emoji). A later `removed` clears it. */
export function foldReactions(ops: ReactionBody[]): ReactionChip[] {
  const latest = new Map<string, ReactionBody>();
  for (const op of [...ops].sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    latest.set(`${op.messageId}\0${op.memberId}\0${op.emoji}`, op);
  }
  const chips = new Map<string, ReactionChip>();
  for (const op of latest.values()) {
    if (op.removed) continue;
    const key = `${op.messageId}\0${op.emoji}`;
    const chip = chips.get(key) || { messageId: op.messageId, emoji: op.emoji, memberIds: [] };
    chip.memberIds.push(op.memberId);
    chips.set(key, chip);
  }
  return [...chips.values()].map(chip => ({
    ...chip,
    memberIds: [...new Set(chip.memberIds)].sort(),
  })).sort((a, b) => a.messageId.localeCompare(b.messageId) || REACTION_EMOJI.indexOf(a.emoji) - REACTION_EMOJI.indexOf(b.emoji));
}

export function memberReacted(chips: ReactionChip[], messageId: string, emoji: ReactionEmoji, memberId: string) {
  return !!chips.find(c => c.messageId === messageId && c.emoji === emoji && c.memberIds.includes(memberId));
}

export const MAX_REACTION_OPS = 4000;
export const COMPACT_REACTIONS_AT = 1000;

/** Drop superseded ops so the log stays bounded while the folded chips stay the same. */
export function compactReactions(ops: ReactionPacket[]): ReactionPacket[] {
  const latest = new Map<string, ReactionPacket>();
  for (const op of [...ops].sort((a, b) => a.body.at - b.body.at || (a.body.id < b.body.id ? -1 : 1))) {
    latest.set(`${op.body.messageId}\0${op.body.memberId}\0${op.body.emoji}`, op);
  }
  return [...latest.values()].sort((a, b) => a.body.at - b.body.at || (a.body.id < b.body.id ? -1 : 1));
}

export function reactionSyncChunks(roomId: string, ops: ReactionPacket[], maxOps = 200) {
  const chunks: { kind: 'reactions'; roomId: string; ops: ReactionPacket[] }[] = [];
  for (let i = 0; i < ops.length; i += maxOps) {
    chunks.push({ kind: 'reactions', roomId, ops: ops.slice(i, i + maxOps) });
  }
  return chunks;
}
