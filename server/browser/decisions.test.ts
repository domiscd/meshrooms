import { describe, expect, test } from 'bun:test';
import {
  type DecisionBody,
  type DecisionPacket,
  type VoteBody,
  type VotePacket,
  compactDecisions,
  foldDecisions,
  validDecisionBody,
  validVoteBody,
} from '../../src/browser/decisions';

const ROOM_ID = '11111111-1111-4111-8111-111111111111';
const DEV_A = 'a'.repeat(64);
const DEV_B = 'b'.repeat(64);
const DEV_C = 'c'.repeat(64);

const HUMAN_IGOR = '925fd63e-97c3-4471-af10-7d376b036bc9';
const HUMAN_DOMINIQUE = '437654ce-f4e1-4c71-83c3-1b3638aa7b0f';
const AGENT_GEMINI = 'af6de434-a610-4590-8960-e30c080c9b98';
const AGENT_OPUS = 'f5979e67-1949-445e-8811-3985dfa9c932';

describe('Decisions CRDT engine', () => {
  test('validates decision and vote structures strictly', () => {
    const validDecision: DecisionBody = {
      kind: 'decision',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId: crypto.randomUUID(),
      revision: 1,
      at: Date.now(),
      authorId: HUMAN_IGOR,
      deviceId: DEV_A,
      title: 'Choose storage architecture',
      context: 'Tradeoffs between SQLite and WormDB',
      options: [
        { id: 'opt-sqlite', label: 'SQLite' },
        { id: 'opt-wormdb', label: 'WormDB' },
      ],
      mode: 'single',
      status: 'open',
    };

    expect(validDecisionBody(validDecision, ROOM_ID)).toBe(true);
    expect(validDecisionBody({ ...validDecision, roomId: 'wrong-room' }, ROOM_ID)).toBe(false);
    expect(validDecisionBody({ ...validDecision, options: [{ id: 'opt1', label: 'Only one' }] }, ROOM_ID)).toBe(false);
    expect(validDecisionBody({ ...validDecision, title: '' }, ROOM_ID)).toBe(false);

    const validVote: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId: validDecision.decisionId,
      memberId: AGENT_GEMINI,
      deviceId: DEV_B,
      role: 'agent',
      selectedOptionIds: ['opt-wormdb'],
      opinion: 'WormDB provides immutable audit trails',
      revision: 1,
      at: Date.now(),
    };

    expect(validVoteBody(validVote, ROOM_ID)).toBe(true);
    expect(validVoteBody({ ...validVote, role: 'invalid' as any }, ROOM_ID)).toBe(false);
    expect(validVoteBody({ ...validVote, selectedOptionIds: [] }, ROOM_ID)).toBe(false);
  });

  test('human votes determine majority and draw is a supported outcome', () => {
    const decisionId = crypto.randomUUID();
    const decOp: DecisionBody = {
      kind: 'decision',
      roomId: ROOM_ID,
      id: '00000000-0000-4000-8000-000000000001',
      decisionId,
      revision: 1,
      at: 1000,
      authorId: HUMAN_IGOR,
      deviceId: DEV_A,
      title: 'Plan review',
      context: '',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      mode: 'single',
      status: 'open',
    };

    // Igor votes Approve.
    const voteIgor: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: '00000000-0000-4000-8000-000000000010',
      decisionId,
      memberId: HUMAN_IGOR,
      deviceId: DEV_A,
      role: 'human',
      selectedOptionIds: ['approve'],
      revision: 1,
      at: 1100,
    };

    let folded = foldDecisions([decOp], [voteIgor]);
    expect(folded[0].leadingOptionIds).toEqual(['approve']);
    expect(folded[0].isDraw).toBe(false);
    expect(folded[0].totalHumanVoters).toBe(1);

    // Dominique votes Reject -> 1-1 tie (draw!).
    const voteDominique: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: '00000000-0000-4000-8000-000000000011',
      decisionId,
      memberId: HUMAN_DOMINIQUE,
      deviceId: DEV_B,
      role: 'human',
      selectedOptionIds: ['reject'],
      revision: 1,
      at: 1200,
    };

    folded = foldDecisions([decOp], [voteIgor, voteDominique]);
    expect(folded[0].leadingOptionIds.sort()).toEqual(['approve', 'reject']);
    expect(folded[0].isDraw).toBe(true);
    expect(folded[0].totalHumanVoters).toBe(2);
  });

  test('agent votes are advisory with rationales and never break human draws', () => {
    const decisionId = crypto.randomUUID();
    const decOp: DecisionBody = {
      kind: 'decision',
      roomId: ROOM_ID,
      id: '00000000-0000-4000-8000-000000000001',
      decisionId,
      revision: 1,
      at: 1000,
      authorId: HUMAN_IGOR,
      deviceId: DEV_A,
      title: 'Plan review',
      context: '',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject' },
      ],
      mode: 'single',
      status: 'open',
    };

    // Humans are tied 1 vs 1.
    const voteIgor: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_IGOR,
      deviceId: DEV_A,
      role: 'human',
      selectedOptionIds: ['approve'],
      revision: 1,
      at: 1100,
    };
    const voteDominique: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_DOMINIQUE,
      deviceId: DEV_B,
      role: 'human',
      selectedOptionIds: ['reject'],
      revision: 1,
      at: 1200,
    };

    // Two agents both advise 'approve' with opinions.
    const voteGemini: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: AGENT_GEMINI,
      deviceId: DEV_C,
      role: 'agent',
      selectedOptionIds: ['approve'],
      opinion: 'The design is sound and verified by tests.',
      revision: 1,
      at: 1300,
    };
    const voteOpus: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: AGENT_OPUS,
      deviceId: DEV_C,
      role: 'agent',
      selectedOptionIds: ['approve'],
      opinion: 'Clean separation of concerns.',
      revision: 1,
      at: 1350,
    };

    const folded = foldDecisions([decOp], [voteIgor, voteDominique, voteGemini, voteOpus]);
    const dec = folded[0];

    // Humans remain in a draw even though 2 agents voted 'approve'!
    expect(dec.isDraw).toBe(true);
    expect(dec.leadingOptionIds.sort()).toEqual(['approve', 'reject']);

    // Human tallies reflect 1 vs 1.
    const approveTally = dec.tallies.find(t => t.id === 'approve')!;
    const rejectTally = dec.tallies.find(t => t.id === 'reject')!;
    expect(approveTally.humanVotes).toBe(1);
    expect(rejectTally.humanVotes).toBe(1);

    // Agent advisory opinions are visible with their rationales.
    expect(approveTally.agentVotes).toBe(2);
    expect(rejectTally.agentVotes).toBe(0);
    const geminiRecord = approveTally.voters.find(v => v.memberId === AGENT_GEMINI);
    expect(geminiRecord?.opinion).toBe('The design is sound and verified by tests.');
  });

  test('vote revisions override earlier votes without relying on wall-clock time', () => {
    const decisionId = crypto.randomUUID();
    const decOp: DecisionBody = {
      kind: 'decision',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      revision: 1,
      at: 1000,
      authorId: HUMAN_IGOR,
      deviceId: DEV_A,
      title: 'Choice',
      context: '',
      options: [
        { id: 'opt1', label: 'One' },
        { id: 'opt2', label: 'Two' },
      ],
      mode: 'single',
      status: 'open',
    };

    // First vote: revision 1, at timestamp 5000 (clock ahead).
    const voteV1: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_IGOR,
      deviceId: DEV_A,
      role: 'human',
      selectedOptionIds: ['opt1'],
      revision: 1,
      at: 5000,
    };

    // Second vote: revision 2, at timestamp 2000 (clock corrected backwards).
    const voteV2: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_IGOR,
      deviceId: DEV_A,
      role: 'human',
      selectedOptionIds: ['opt2'],
      revision: 2,
      at: 2000,
    };

    // Highest revision wins despite lower wall-clock timestamp!
    const folded = foldDecisions([decOp], [voteV1, voteV2]);
    expect(folded[0].leadingOptionIds).toEqual(['opt2']);
    expect(folded[0].tallies.find(t => t.id === 'opt1')?.humanVotes).toBe(0);
    expect(folded[0].tallies.find(t => t.id === 'opt2')?.humanVotes).toBe(1);
  });

  test('auto-resolves on human consensus and removal permanently hides decisions', () => {
    const decisionId = crypto.randomUUID();
    const decOp: DecisionBody = {
      kind: 'decision',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      revision: 1,
      at: 1000,
      authorId: HUMAN_IGOR,
      deviceId: DEV_A,
      title: 'Consensus',
      context: '',
      options: [
        { id: 'optA', label: 'A' },
        { id: 'optB', label: 'B' },
      ],
      mode: 'single',
      status: 'open',
    };

    const voteIgor: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_IGOR,
      deviceId: DEV_A,
      role: 'human',
      selectedOptionIds: ['optA'],
      revision: 1,
      at: 1100,
    };
    const voteDominique: VoteBody = {
      kind: 'decision_vote',
      roomId: ROOM_ID,
      id: crypto.randomUUID(),
      decisionId,
      memberId: HUMAN_DOMINIQUE,
      deviceId: DEV_B,
      role: 'human',
      selectedOptionIds: ['optA'],
      revision: 1,
      at: 1200,
    };

    // When all active humans [Igor, Dominique] have voted optA:
    const folded = foldDecisions([decOp], [voteIgor, voteDominique], [HUMAN_IGOR, HUMAN_DOMINIQUE]);
    expect(folded[0].status).toBe('resolved');
    expect(folded[0].outcome?.winnerOptionIds).toEqual(['optA']);
    expect(folded[0].outcome?.isDraw).toBe(false);

    // Later removal operation hides the decision for everyone.
    const removeOp: DecisionBody = {
      ...decOp,
      id: crypto.randomUUID(),
      revision: 2,
      at: 1300,
      removed: true,
    };

    const afterRemoval = foldDecisions([decOp, removeOp], [voteIgor, voteDominique], [HUMAN_IGOR, HUMAN_DOMINIQUE]);
    expect(afterRemoval).toEqual([]);
  });

  test('compaction preserves latest state and prunes superseded ops', () => {
    const decisionId = crypto.randomUUID();
    const dec1: DecisionPacket = {
      body: {
        kind: 'decision',
        roomId: ROOM_ID,
        id: '00000000-0000-4000-8000-000000000001',
        decisionId,
        revision: 1,
        at: 1000,
        authorId: HUMAN_IGOR,
        deviceId: DEV_A,
        title: 'Initial',
        context: '',
        options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        mode: 'single',
        status: 'open',
      },
      signature: 'sig1',
    };
    const dec2: DecisionPacket = {
      body: {
        ...dec1.body,
        id: '00000000-0000-4000-8000-000000000002',
        revision: 2,
        title: 'Updated Title',
        at: 2000,
      },
      signature: 'sig2',
    };

    const vote1: VotePacket = {
      body: {
        kind: 'decision_vote',
        roomId: ROOM_ID,
        id: crypto.randomUUID(),
        decisionId,
        memberId: HUMAN_IGOR,
        deviceId: DEV_A,
        role: 'human',
        selectedOptionIds: ['a'],
        revision: 1,
        at: 1500,
      },
      signature: 'sig3',
    };
    const vote2: VotePacket = {
      body: {
        ...vote1.body,
        id: crypto.randomUUID(),
        selectedOptionIds: ['b'],
        revision: 2,
        at: 2500,
      },
      signature: 'sig4',
    };

    const compacted = compactDecisions([dec1, dec2], [vote1, vote2]);
    expect(compacted.decisions.length).toBe(1);
    expect(compacted.decisions[0].body.title).toBe('Updated Title');
    expect(compacted.decisions[0].body.revision).toBe(2);

    expect(compacted.votes.length).toBe(1);
    expect(compacted.votes[0].body.selectedOptionIds).toEqual(['b']);
    expect(compacted.votes[0].body.revision).toBe(2);
  });
});
