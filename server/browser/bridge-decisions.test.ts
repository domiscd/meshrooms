import { expect, test } from 'bun:test';
import { foldDecisions, openDecision } from '../../src/browser/decisions';
import { pickDecision } from '../browser-agent';

test('a quoted decision id prefers the agent’s own decision and never guesses between other people’s copies', () => {
  const roomId = crypto.randomUUID(), deviceId = 'a'.repeat(64), [me, igor, dom] = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
  const room = { ownerId: igor, members: [{ id: me, role: 'agent' as const, operatorId: igor }, { id: igor }, { id: dom }] };
  const mine = openDecision({ roomId, deviceId, memberId: me, question: 'Mine', options: ['A', 'B'] });
  const copy = openDecision({ roomId, deviceId, memberId: dom, question: 'Copy', options: ['A', 'B'], decisionId: mine.decisionId });
  const other = openDecision({ roomId, deviceId, memberId: igor, question: 'Igor’s', options: ['A', 'B'], decisionId: mine.decisionId });
  expect(pickDecision(foldDecisions([mine, copy], room), mine.decisionId, me)?.question).toBe('Mine');
  expect(pickDecision(foldDecisions([mine], room), mine.decisionId, igor)?.question).toBe('Mine');
  expect(() => pickDecision(foldDecisions([copy, other], room), mine.decisionId, me)).toThrow('Several decisions');
  expect(pickDecision(foldDecisions([mine], room), crypto.randomUUID(), me)).toBeUndefined();
});
