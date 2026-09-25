import { describe, expect, test } from 'bun:test';
import {
  compactReactions,
  foldReactions,
  isReactionEmoji,
  memberReacted,
  validReactionBody,
  type ReactionBody,
  type ReactionPacket,
} from './reactions';

const room = '45424fde-7562-4a96-9472-a4eea17545c5';
const message = '11111111-1111-4111-8111-111111111111';
const alice = '22222222-2222-4222-8222-222222222222';
const bob = '33333333-3333-4333-8333-333333333333';
const device = 'a'.repeat(64);

function op(partial: Partial<ReactionBody> & Pick<ReactionBody, 'id' | 'memberId' | 'emoji' | 'at'>): ReactionBody {
  return {
    kind: 'reaction',
    roomId: room,
    deviceId: device,
    messageId: message,
    ...partial,
  };
}

describe('browser reactions', () => {
  test('accepts the fixed emoji set only', () => {
    expect(isReactionEmoji('👍')).toBe(true);
    expect(isReactionEmoji('🚀')).toBe(false);
    expect(validReactionBody(op({ id: '44444444-4444-4444-8444-444444444444', memberId: alice, emoji: '👍', at: 1 }), room)).toBe(true);
    expect(validReactionBody(op({ id: '44444444-4444-4444-8444-444444444444', memberId: alice, emoji: '🚀' as never, at: 1 }), room)).toBe(false);
  });

  test('folds counts and toggles with a later removal', () => {
    const addAlice = op({ id: '55555555-5555-4555-8555-555555555555', memberId: alice, emoji: '👍', at: 1 });
    const addBob = op({ id: '66666666-6666-4666-8666-666666666666', memberId: bob, emoji: '👍', at: 2 });
    const addHeart = op({ id: '77777777-7777-4777-8777-777777777777', memberId: alice, emoji: '❤️', at: 3 });
    const removeAlice = op({ id: '88888888-8888-4888-8888-888888888888', memberId: alice, emoji: '👍', at: 4, removed: true });
    const chips = foldReactions([addAlice, addBob, addHeart, removeAlice]);
    expect(chips).toEqual([
      { messageId: message, emoji: '👍', memberIds: [bob] },
      { messageId: message, emoji: '❤️', memberIds: [alice] },
    ]);
    expect(memberReacted(chips, message, '👍', bob)).toBe(true);
    expect(memberReacted(chips, message, '👍', alice)).toBe(false);
  });

  test('compaction keeps only the latest op per member emoji', () => {
    const packets: ReactionPacket[] = [
      { body: op({ id: '55555555-5555-4555-8555-555555555555', memberId: alice, emoji: '👍', at: 1 }), signature: 'a' },
      { body: op({ id: '66666666-6666-4666-8666-666666666666', memberId: alice, emoji: '👍', at: 2, removed: true }), signature: 'b' },
      { body: op({ id: '77777777-7777-4777-8777-777777777777', memberId: bob, emoji: '😂', at: 3 }), signature: 'c' },
    ];
    const compacted = compactReactions(packets);
    expect(compacted.map(p => p.body.id)).toEqual([
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ]);
    expect(foldReactions(compacted.map(p => p.body))).toEqual([
      { messageId: message, emoji: '😂', memberIds: [bob] },
    ]);
  });
});
