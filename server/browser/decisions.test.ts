import { expect, test } from 'bun:test';
import { COMPACT_DECISIONS_AT, admissible, castVote, compactDecisions, decisionChunks, decisionWakes, due, foldDecisions, nextVoteRevision, openDecision, reviseDecision, tallyVotes, validDecisionBody, validVoteBody,
  type DecisionBody, type DecisionPacket, type RoomMembers, type VoteBody } from '../../src/browser/decisions';

const roomId = crypto.randomUUID(), deviceId = 'a'.repeat(64);
const [igor, dom, sam, vesper, gemini] = Array.from({ length: 5 }, () => crypto.randomUUID());
const room: RoomMembers = { ownerId: igor, members: [{ id: igor, role: 'human' }, { id: dom, role: 'human' }, { id: sam }, { id: vesper, role: 'agent', operatorId: igor }, { id: gemini, role: 'agent', operatorId: dom }] };
const as = (memberId: string) => ({ roomId, deviceId, memberId });
const fold = (ops: (DecisionBody | VoteBody)[]) => foldDecisions(ops, room);

test('agents open decisions; only people’s votes count, and agents’ advice is kept apart', () => {
  const open = openDecision({ ...as(vesper), question: 'Which storage for history?', options: ['WormDB', 'IndexedDB only'], askAgents: true });
  expect(validDecisionBody(open, roomId)).toBe(true);
  let d = fold([open])[0];
  const ops: (DecisionBody | VoteBody)[] = [open, castVote(as(igor), d, 'o1', 'replication'), castVote(as(gemini), d, 'o2', 'simpler'), castVote(as(vesper), d, 'o2')];
  d = fold(ops)[0];
  expect(d.tally).toMatchObject({ result: 'decided', optionIds: ['o1'], tally: { o1: 1, o2: 0 }, voters: 1, people: 3 });
  expect(d.votes.filter(v => !v.counts).map(v => v.memberId).sort()).toEqual([gemini, vesper].sort());
  expect(d.settled).toBe(false);
});

test('a majority settles early, a split room is a draw, and the latest vote per person counts', () => {
  const open = openDecision({ ...as(dom), question: 'Ship today?', options: ['Yes', 'No'] });
  let d = fold([open])[0];
  const ops: (DecisionBody | VoteBody)[] = [open, castVote(as(igor), d, 'o1'), castVote(as(dom), d, 'o1')];
  expect(fold(ops)[0]).toMatchObject({ settled: true, tally: { result: 'decided', optionIds: ['o1'] } }); // 2 of 3 people: sam can't change it
  const split = [open, castVote(as(igor), d, 'o1'), castVote(as(dom), d, 'o2'), castVote(as(sam), d, 'o1')];
  const changed = [...split, castVote(as(sam), d, 'o2', '', nextVoteRevision(split.map(o => o), d, sam))];
  expect(fold(changed)[0].tally).toMatchObject({ result: 'decided', optionIds: ['o2'], tally: { o1: 1, o2: 2 } });
  const withdrawn = [...split, castVote(as(sam), d, null, '', 2)];
  expect(fold(withdrawn)[0]).toMatchObject({ settled: false, tally: { result: 'draw', optionIds: ['o1', 'o2'] } });
  expect(tallyVotes(d.options, [], 3).tally.result).toBe('no-votes');
});

test('closing records the tally; only the creator, its operator, or the host may close or change the terms', () => {
  const open = openDecision({ ...as(vesper), question: 'Plan OK?', mode: 'plan-review', context: '1. do x\n2. do y' });
  expect(open.options.map(o => o.id)).toEqual(['approve', 'changes', 'reject']);
  let d = fold([open])[0];
  const vote = castVote(as(igor), d, 'approve', 'go');
  d = fold([open, vote])[0];
  expect(() => reviseDecision(as(dom), d, { addOption: 'Maybe' })).not.toThrow(); // building is fine; the fold rejects it for plan reviews
  const byDom = reviseDecision(as(dom), d, { close: true }), byOperator = reviseDecision(as(igor), d, { close: true });
  expect(fold([open, vote, byDom])[0].state).toBe('open');
  const closed = fold([open, vote, byOperator])[0];
  expect(closed).toMatchObject({ state: 'closed', outcome: { result: 'decided', optionIds: ['approve'], voters: 1, people: 3 } });
  // Later votes and revisions never change a closed outcome.
  const late = castVote(as(dom), d, 'reject');
  expect(fold([open, vote, byOperator, late, reviseDecision(as(vesper), closed, {})])[0].outcome).toEqual(closed.outcome);
});

test('anyone adds options while open; concurrent revisions settle by operation id, not clocks', () => {
  const open = openDecision({ ...as(igor), question: 'Name?', options: ['A', 'B'] });
  const d = fold([open])[0];
  const x = { ...reviseDecision(as(sam), d, { addOption: 'C' }), id: '00000000-0000-4000-8000-000000000002', at: 1 };
  const y = { ...reviseDecision(as(dom), d, { addOption: 'D' }), id: '00000000-0000-4000-8000-000000000001', at: 9_999_999_999_999 };
  expect(fold([open, x, y])[0].options.map(o => o.label)).toEqual(['A', 'B', 'D']);
  expect(fold([y, open, x])[0].options.map(o => o.label)).toEqual(['A', 'B', 'D']);
  // Options only grow: a revision that renames an option is ignored.
  const rename = { ...reviseDecision(as(igor), d, {}), options: [{ ...d.options[0], label: 'Z' }, d.options[1]] };
  expect(fold([open, rename])[0].options[0].label).toBe('A');
});

test('deadlines make a decision due; agents wake when asked and when their own decision resolves', () => {
  const asked = openDecision({ ...as(igor), question: 'Thoughts?', options: ['A', 'B'], askAgents: [vesper] });
  const mine = openDecision({ ...as(vesper), question: 'Proceed?', options: ['Yes', 'No'], closesAt: 1000 });
  const ops: (DecisionBody | VoteBody)[] = [asked, mine];
  expect(due(fold(ops).find(d => d.id === mine.decisionId)!, 1000)).toBe(true);
  expect(decisionWakes(ops, room, vesper, 0).asked.map(d => d.id)).toEqual([asked.decisionId]);
  expect(decisionWakes(ops, room, gemini, 0).asked).toEqual([]);
  const advice = castVote(as(vesper), fold(ops)[0], 'o2', 'B is simpler');
  const closed = reviseDecision(as(vesper), fold(ops).find(d => d.id === mine.decisionId)!, { close: true });
  const later = [...ops, advice, closed];
  const wakes = decisionWakes(later, room, vesper, ops.length);
  expect(wakes.asked).toEqual([]);
  expect(wakes.resolved.map(d => [d.id, d.outcome?.result])).toEqual([[mine.decisionId, 'no-votes']]);
  expect(decisionWakes(later, room, vesper, later.length).resolved).toEqual([]);
});

test('validation rejects malformed operations, and sync chunks stay small', () => {
  const open = openDecision({ ...as(igor), question: 'Q', options: ['A', 'B'] });
  expect(() => openDecision({ ...as(igor), question: 'Q', options: ['only one'] })).toThrow();
  expect(validDecisionBody({ ...open, options: [...open.options, open.options[0]] }, roomId)).toBe(false);
  expect(validDecisionBody({ ...open, state: 'closed' }, roomId)).toBe(false);
  expect(validDecisionBody({ ...open, question: 'x'.repeat(201) }, roomId)).toBe(false);
  expect(validVoteBody({ ...castVote(as(igor), fold([open])[0], 'o1'), comment: 'x'.repeat(501) }, roomId)).toBe(false);
  const packets = Array.from({ length: 60 }, () => ({ body: openDecision({ ...as(igor), question: 'Q'.repeat(200), context: 'c'.repeat(1000), options: ['A', 'B'] }), signature: 's' }));
  const chunks = decisionChunks(roomId, packets);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.every(c => JSON.stringify(c).length < 20_000)).toBe(true);
  expect(chunks.flatMap(c => c.ops).length).toBe(60);
});

test('a competing first revision with the same id is a separate decision, never a takeover', () => {
  const victim = openDecision({ ...as(vesper), question: 'Real question', options: ['A', 'B'] });
  const forged = { ...openDecision({ ...as(dom), question: 'Hijacked', options: ['X', 'Y'], decisionId: victim.decisionId }), id: '00000000-0000-4000-8000-000000000000' };
  const decisions = fold([victim, forged]);
  const real = decisions.find(d => d.createdBy === vesper)!;
  expect(real).toMatchObject({ question: 'Real question', createdBy: vesper });
  expect(decisions.find(d => d.createdBy === dom)!.key).not.toBe(real.key);
  // Signing revision 1 in someone else's name is invalid, and a revision can't move a decision to another creator.
  expect(validDecisionBody({ ...victim, memberId: dom }, roomId)).toBe(false);
  const moved = { ...reviseDecision(as(dom), real, { addOption: 'C' }), createdBy: dom };
  expect(fold([victim, moved]).find(d => d.createdBy === vesper)!.options.length).toBe(2);
});

test('a close must add up: forged tallies and agents counted as people are rejected; late and missing votes are visible', () => {
  const open = openDecision({ ...as(vesper), question: 'Go?', options: ['Yes', 'No'] });
  let d = fold([open])[0];
  const igorVote = castVote(as(igor), d, 'o2'), geminiAdvice = castVote(as(gemini), d, 'o1');
  const ops: (DecisionBody | VoteBody)[] = [open, igorVote, geminiAdvice];
  d = fold(ops)[0];
  const honest = reviseDecision(as(vesper), d, { close: true });
  expect(honest.counted).toEqual([{ vote: igorVote.id, memberId: igor, optionId: 'o2' }]);
  expect(fold([...ops, honest])[0]).toMatchObject({ state: 'closed', verified: true, uncounted: 0, outcome: { result: 'decided', optionIds: ['o2'] } });
  const forgedTally = { ...honest, outcome: { ...honest.outcome!, optionIds: ['o1'], tally: { o1: 1, o2: 0 } }, counted: [{ vote: igorVote.id, memberId: igor, optionId: 'o1' }] };
  expect(fold([...ops, forgedTally])[0].state).toBe('open'); // the pinned vote says o1, but Igor's vote here is o2
  const agentCounted = { ...honest, outcome: { ...honest.outcome!, result: 'draw' as const, optionIds: ['o1', 'o2'], tally: { o1: 1, o2: 1 }, voters: 2 },
    counted: [...honest.counted!, { vote: geminiAdvice.id, memberId: gemini, optionId: 'o1' }] };
  expect(fold([...ops, agentCounted])[0].state).toBe('open');
  // A pinned vote this device hasn't received yet: still closed, marked unverified. A vote after the close is uncounted.
  expect(fold([open, geminiAdvice, honest])[0]).toMatchObject({ state: 'closed', verified: false });
  const late = castVote(as(dom), d, 'o1');
  expect(fold([...ops, honest, late])[0]).toMatchObject({ uncounted: 1, outcome: { optionIds: ['o2'] } });
});

test('votes need a decision this device holds; each member has a share of the cap; a majority closes it', () => {
  const open = openDecision({ ...as(igor), question: 'Q', options: ['A', 'B'] });
  const d = fold([open])[0];
  const stray = { ...castVote(as(dom), d, 'o1'), decisionId: crypto.randomUUID() };
  expect(admissible([open], [stray, castVote(as(dom), d, 'o1')]).map(o => o.decisionId)).toEqual([open.decisionId]);
  expect(admissible([], [open, castVote(as(dom), d, 'o2')]).length).toBe(2); // decision and vote in one sync batch
  const flood = Array.from({ length: 450 }, (_, i) => castVote(as(dom), d, 'o1', '', i + 1));
  expect(admissible([open], flood).length).toBe(400);
  const two = fold([open, castVote(as(igor), d, 'o1'), castVote(as(dom), d, 'o1')])[0];
  expect(two).toMatchObject({ settled: true });
  expect(due(two, Date.now())).toBe(true); // a majority of people makes it certain, so it closes without waiting for Sam
  const one = fold([open, castVote(as(igor), d, 'o1')])[0];
  expect(due(one, Date.now())).toBe(false); // one of three people can still be outvoted
});

test('stewardship stays with the creator after someone else adds an option', () => {
  const open = openDecision({ ...as(sam), question: 'Ship today?', options: ['Yes', 'No'] });
  const added = reviseDecision(as(igor), fold([open])[0], { addOption: 'Tomorrow' });
  let d = fold([open, added])[0];
  const ops: (DecisionBody | VoteBody)[] = [open, added, castVote(as(igor), d, 'o2'), castVote(as(igor), d, 'o1', '', 2), castVote(as(sam), d, 'o1')];
  d = fold(ops)[0];
  expect(due(d, Date.now())).toBe(true);
  expect(fold([...ops, reviseDecision(as(sam), d, { close: true })])[0]).toMatchObject({ state: 'closed', revision: 3, outcome: { optionIds: ['o1'] } });
  // A non-steward who added an option gains nothing: they can't withdraw it or change the question.
  const byDom = reviseDecision(as(dom), fold([open])[0], { addOption: 'Never' });
  const domOps = [open, byDom];
  const withdraw = reviseDecision(as(dom), fold(domOps)[0], { withdraw: true });
  const retitled = { ...reviseDecision(as(dom), fold(domOps)[0], {}), question: 'Something else' };
  expect(fold([...domOps, withdraw])[0]).toMatchObject({ state: 'open', revision: 2 });
  expect(fold([...domOps, retitled])[0].question).toBe('Ship today?');
  expect(fold([...domOps, reviseDecision(as(sam), fold(domOps)[0], { withdraw: true })])[0].state).toBe('withdrawn');
});

test('compaction preserves verified outcomes, drops superseded vote revisions, and shrinks the ops set', () => {
  const open = openDecision({ ...as(igor), question: 'Choose DB', options: ['A', 'B'] });
  let d = fold([open])[0];
  // Igor votes o1, then updates to o2 (rev 2).
  const v1 = castVote(as(igor), d, 'o1', '', 1);
  const v2 = castVote(as(igor), d, 'o2', '', 2);
  // Dom votes o2 (rev 1).
  const vDom = castVote(as(dom), d, 'o2', '', 1);
  const ops = [open, v1, v2, vDom];
  d = fold(ops)[0];
  const closed = reviseDecision(as(igor), d, { close: true });
  const allOps = [...ops, closed];

  const packets: DecisionPacket[] = allOps.map((body, i) => ({ body, signature: `sig-${i}` }));
  const compacted = compactDecisions(packets, room);

  // Igor's superseded v1 vote was dropped because v2 was counted; v2 and vDom are kept because they are pinned in counted.
  expect(compacted.length).toBeLessThan(packets.length);
  const keptIds = new Set(compacted.map(p => p.body.id));
  expect(keptIds.has(v1.id)).toBe(false);
  expect(keptIds.has(v2.id)).toBe(true);
  expect(keptIds.has(vDom.id)).toBe(true);
  expect(keptIds.has(open.id)).toBe(true);
  expect(keptIds.has(closed.id)).toBe(true);

  // Compacting produces the exact same folded outcome and verified state.
  const beforeFold = foldDecisions(allOps, room)[0];
  const afterFold = foldDecisions(compacted.map(p => p.body), room)[0];
  expect(afterFold).toMatchObject({
    state: 'closed',
    verified: true,
    outcome: beforeFold.outcome,
    revision: beforeFold.revision,
  });
  expect(COMPACT_DECISIONS_AT).toBe(2000);
});

test('multi-person e2e: agent asks room, peers advise, people vote, majority settles early, closes honestly, wakes agent', () => {
  // 1. Gemini (agent operated by Dom) asks the room an architectural question.
  const open = openDecision({
    ...as(gemini),
    question: 'Which index structure for vector search in WormDB?',
    options: ['HNSW', 'Flat IVFPQ', 'Brute force'],
    context: 'Considering memory overhead vs recall latency',
    askAgents: true,
  });
  expect(validDecisionBody(open, roomId)).toBe(true);

  let current = fold([open])[0];
  expect(current.options.map(o => o.label)).toEqual(['HNSW', 'Flat IVFPQ', 'Brute force']);

  // 2. Peer agents provide advisory opinions (they must not count towards the tally or quorum).
  const vesperAdvice = castVote(as(vesper), current, 'o1', 'Lowest query latency');
  const geminiAdvice = castVote(as(gemini), current, 'o1', 'Best recall');
  const startOps: (DecisionBody | VoteBody)[] = [open, vesperAdvice, geminiAdvice];

  current = fold(startOps)[0];
  expect(current.tally.voters).toBe(0);
  expect(current.tally.result).toBe('no-votes');
  expect(current.votes.filter(v => !v.counts).length).toBe(2);

  // 3. Human votes begin: Dominique votes HNSW ('o1').
  const domVote1 = castVote(as(dom), current, 'o1');
  current = fold([...startOps, domVote1])[0];
  expect(current.tally.voters).toBe(1);
  expect(current.settled).toBe(false);

  // 4. Igor (human host) adds an option 'SCaNN' to the open decision.
  const addedScann = reviseDecision(as(igor), current, { addOption: 'SCaNN' });
  expect(addedScann.options.length).toBe(4);
  const scannOptId = addedScann.options[3].id;

  // 5. Dominique changes vote to SCaNN (revision 2).
  current = fold([...startOps, domVote1, addedScann])[0];
  const domVote2 = castVote(as(dom), current, scannOptId, 'More compact quantization', 2);

  // 6. Igor votes SCaNN. Now 2 of 3 people have voted for SCaNN.
  const igorVote = castVote(as(igor), current, scannOptId, 'Agreed');
  const votingOps = [...startOps, domVote1, addedScann, domVote2, igorVote];
  current = fold(votingOps)[0];

  // 2 people out of 3 voted for SCaNN; Sam (1 remaining) cannot catch up -> settled early!
  expect(current.settled).toBe(true);
  expect(due(current, Date.now())).toBe(true);
  expect(current.tally).toMatchObject({
    result: 'decided',
    optionIds: [scannOptId],
    voters: 2,
    people: 3,
  });

  // 7. Creator (Gemini) closes the decision once due.
  const closed = reviseDecision(as(gemini), current, { close: true });
  expect(closed.state).toBe('closed');
  const allOps = [...votingOps, closed];

  const finalDecisions = fold(allOps);
  const final = finalDecisions[0];
  expect(final.state).toBe('closed');
  expect(final.verified).toBe(true);
  expect(final.outcome?.optionIds).toEqual([scannOptId]);

  // 8. Wake on Consensus: Gemini's device wakes up because its decision resolved!
  const wakes = decisionWakes(allOps, room, gemini, startOps.length);
  expect(wakes.resolved.map(d => d.id)).toEqual([open.decisionId]);
  expect(wakes.resolved[0].outcome?.optionIds).toEqual([scannOptId]);

  // 9. Compaction shrinks the ops while preserving the exact outcome and verified state.
  const packets: DecisionPacket[] = allOps.map((body, i) => ({ body, signature: `sig-${i}` }));
  const compacted = compactDecisions(packets, room);
  expect(compacted.length).toBeLessThan(packets.length);
  expect(foldDecisions(compacted.map(p => p.body), room)[0]).toMatchObject({
    state: 'closed',
    verified: true,
    outcome: final.outcome,
  });
});

