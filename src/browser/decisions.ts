import type { Role } from '../room';

/**
 * Browser-room Decisions: decentralized multiplayer consensus proposals and polls.
 *
 * Like the task board, the room coordinator never sees decision state. Each decision
 * mutation and vote is a signed operation exchanged between peers over WebRTC data
 * channels.
 *
 * Consensus rules (approved by room host):
 * 1. Humans decide: human votes determine the outcome by majority; draws are supported.
 * 2. Agents advise: agent votes carry reasoned opinions and recommendations without
 *    counting toward human quorum or breaking ties.
 * 3. Open ballot: all votes and rationales are visible.
 * 4. Deterministic folding: per-member vote revisions decide conflicts; clocks never decide.
 */

export type DecisionMode = 'single' | 'multiple';
export type DecisionStatus = 'open' | 'resolved' | 'withdrawn';

export type DecisionOption = {
  id: string;
  label: string;
};

export type DecisionOutcome = {
  winnerOptionIds: string[];
  isDraw: boolean;
  resolvedAt: string;
  resolvedBy: string;
};

/** Signed operation representing a decision creation, update, resolution, or removal. */
export type DecisionBody = {
  kind: 'decision';
  roomId: string;
  id: string; // operation UUID
  decisionId: string; // unique decision UUID
  revision: number;
  at: number;
  authorId: string;
  deviceId: string;
  title: string;
  context: string;
  options: DecisionOption[];
  mode: DecisionMode;
  status: DecisionStatus;
  outcome?: DecisionOutcome;
  removed?: true;
};

export type DecisionPacket = { body: DecisionBody; signature: string };

/** Signed operation representing a vote and optional advisory rationale. */
export type VoteBody = {
  kind: 'decision_vote';
  roomId: string;
  id: string; // operation UUID
  decisionId: string;
  memberId: string;
  deviceId: string;
  role: Role;
  selectedOptionIds: string[];
  opinion?: string;
  revision: number; // per-(decisionId, memberId) revision counter starting at 1
  at: number;
};

export type VotePacket = { body: VoteBody; signature: string };

/** Unsigned envelope for peer-to-peer sync. */
export type DecisionsSync = {
  kind: 'decisions';
  roomId: string;
  decisions: DecisionPacket[];
  votes: VotePacket[];
};

export const MAX_DECISION_OPS = 2000;
export const COMPACT_DECISIONS_AT = 1000;
export const MAX_OPTIONS_PER_DECISION = 10;
export const MIN_OPTIONS_PER_DECISION = 2;

const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/i.test(v);
const hex64 = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);

export function validDecisionOption(opt: any): opt is DecisionOption {
  return !!opt && typeof opt === 'object'
    && typeof opt.id === 'string' && opt.id.trim().length > 0 && opt.id.length <= 64
    && typeof opt.label === 'string' && opt.label.trim().length > 0 && opt.label.length <= 120;
}

export function validDecisionBody(b: any, roomId: string): b is DecisionBody {
  if (!b || b.kind !== 'decision' || b.roomId !== roomId) return false;
  if (!uuid(b.id) || !uuid(b.decisionId) || !uuid(b.authorId) || !hex64(b.deviceId)) return false;
  if (!Number.isSafeInteger(b.at) || b.at <= 0) return false;
  if (!Number.isSafeInteger(b.revision) || b.revision < 1 || b.revision > 1_000_000) return false;
  if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 140) return false;
  if (typeof b.context !== 'string' || b.context.length > 4000) return false;
  if (!Array.isArray(b.options) || b.options.length < MIN_OPTIONS_PER_DECISION || b.options.length > MAX_OPTIONS_PER_DECISION) return false;
  const optIds = new Set<string>();
  for (const opt of b.options) {
    if (!validDecisionOption(opt) || optIds.has(opt.id)) return false;
    optIds.add(opt.id);
  }
  if (b.mode !== 'single' && b.mode !== 'multiple') return false;
  if (b.status !== 'open' && b.status !== 'resolved' && b.status !== 'withdrawn') return false;
  if (b.removed !== undefined && b.removed !== true) return false;
  if (b.outcome) {
    if (!Array.isArray(b.outcome.winnerOptionIds) || !b.outcome.winnerOptionIds.every((id: string) => optIds.has(id))) return false;
    if (typeof b.outcome.isDraw !== 'boolean') return false;
    if (typeof b.outcome.resolvedAt !== 'string' || !uuid(b.outcome.resolvedBy)) return false;
  }
  return true;
}

export function validVoteBody(b: any, roomId: string, optionsMap?: Set<string>): b is VoteBody {
  if (!b || b.kind !== 'decision_vote' || b.roomId !== roomId) return false;
  if (!uuid(b.id) || !uuid(b.decisionId) || !uuid(b.memberId) || !hex64(b.deviceId)) return false;
  if (b.role !== 'human' && b.role !== 'agent') return false;
  if (!Number.isSafeInteger(b.at) || b.at <= 0) return false;
  if (!Number.isSafeInteger(b.revision) || b.revision < 1 || b.revision > 1_000_000) return false;
  if (!Array.isArray(b.selectedOptionIds) || b.selectedOptionIds.length === 0) return false;
  if (b.opinion !== undefined && (typeof b.opinion !== 'string' || b.opinion.length > 500)) return false;
  if (optionsMap) {
    for (const optId of b.selectedOptionIds) {
      if (!optionsMap.has(optId)) return false;
    }
  }
  return true;
}

/** Deterministic comparator: revision first, then operation UUID lexicographically. */
function compareOps<T extends { revision: number; id: string }>(a: T, b: T): number {
  return a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type VoterRecord = {
  memberId: string;
  role: Role;
  selectedOptionIds: string[];
  opinion?: string;
  at: number;
  revision: number;
};

export type OptionTally = {
  id: string;
  label: string;
  humanVotes: number;
  agentVotes: number;
  voters: VoterRecord[];
};

export type DecisionView = {
  id: string;
  revision: number;
  authorId: string;
  title: string;
  context: string;
  options: DecisionOption[];
  mode: DecisionMode;
  status: DecisionStatus;
  createdAt: string;
  updatedAt: string;
  tallies: OptionTally[];
  totalHumanVoters: number;
  totalAgentVoters: number;
  leadingOptionIds: string[];
  isDraw: boolean;
  outcome?: DecisionOutcome;
};

/**
 * Fold decision operations and votes deterministically.
 *
 * Rules:
 * - A decision's highest revision wins. Removal (`removed: true`) permanently hides it.
 * - For each member and decision, the vote with the highest revision wins.
 * - Human votes determine leading options and resolution.
 * - Draws occur when the top human vote count is shared by 2+ options.
 * - Agent votes are tracked in `agentVotes` and `voters` for reasoned advisory visibility.
 */
export function foldDecisions(
  decisions: DecisionBody[],
  votes: VoteBody[],
  activeHumans?: string[]
): DecisionView[] {
  // 1. Group decision operations by decisionId.
  const byDecision = new Map<string, DecisionBody[]>();
  for (const op of decisions) {
    const list = byDecision.get(op.decisionId) || [];
    list.push(op);
    byDecision.set(op.decisionId, list);
  }

  // 2. Group votes by decisionId, keeping the highest revision per memberId.
  const votesByDecision = new Map<string, Map<string, VoteBody>>();
  for (const vote of votes) {
    const decVotes = votesByDecision.get(vote.decisionId) || new Map<string, VoteBody>();
    const existing = decVotes.get(vote.memberId);
    if (!existing || compareOps(vote, existing) > 0) {
      decVotes.set(vote.memberId, vote);
    }
    votesByDecision.set(vote.decisionId, decVotes);
  }

  const results: DecisionView[] = [];

  for (const [decisionId, opsList] of byDecision) {
    // Check if any operation marked it as removed.
    if (opsList.some(op => op.removed)) continue;

    const sortedOps = [...opsList].sort(compareOps);
    const first = sortedOps[0];
    const latest = sortedOps[sortedOps.length - 1];

    const validOptionIds = new Set(latest.options.map(o => o.id));
    const rawVotes = Array.from(votesByDecision.get(decisionId)?.values() || []);

    // Filter votes to valid options only.
    const effectiveVotes: VoterRecord[] = rawVotes
      .filter(v => v.selectedOptionIds.some(optId => validOptionIds.has(optId)))
      .map(v => ({
        memberId: v.memberId,
        role: v.role,
        selectedOptionIds: v.selectedOptionIds.filter(optId => validOptionIds.has(optId)),
        opinion: v.opinion,
        at: v.at,
        revision: v.revision,
      }));

    // Build tallies for each option.
    const tallyMap = new Map<string, OptionTally>();
    for (const opt of latest.options) {
      tallyMap.set(opt.id, {
        id: opt.id,
        label: opt.label,
        humanVotes: 0,
        agentVotes: 0,
        voters: [],
      });
    }

    let humanVotersCount = 0;
    let agentVotersCount = 0;
    const countedHumans = new Set<string>();
    const countedAgents = new Set<string>();

    for (const voter of effectiveVotes) {
      if (voter.role === 'human') {
        if (!countedHumans.has(voter.memberId)) {
          countedHumans.add(voter.memberId);
          humanVotersCount++;
        }
      } else {
        if (!countedAgents.has(voter.memberId)) {
          countedAgents.add(voter.memberId);
          agentVotersCount++;
        }
      }

      for (const optId of voter.selectedOptionIds) {
        const t = tallyMap.get(optId);
        if (t) {
          if (voter.role === 'human') t.humanVotes++;
          else t.agentVotes++;
          t.voters.push(voter);
        }
      }
    }

    const tallies = latest.options.map(opt => tallyMap.get(opt.id)!);

    // Calculate leaders and draw based on human votes.
    let maxHumanVotes = 0;
    for (const t of tallies) {
      if (t.humanVotes > maxHumanVotes) maxHumanVotes = t.humanVotes;
    }

    const leaders: string[] = [];
    if (maxHumanVotes > 0) {
      for (const t of tallies) {
        if (t.humanVotes === maxHumanVotes) leaders.push(t.id);
      }
    }

    const isDraw = leaders.length > 1;

    // Check if auto-resolved (when all active humans have voted and status is open).
    let status = latest.status;
    let outcome = latest.outcome;

    if (status === 'open' && activeHumans && activeHumans.length > 0) {
      const allHumansVoted = activeHumans.every(hId => countedHumans.has(hId));
      if (allHumansVoted) {
        status = 'resolved';
        outcome = {
          winnerOptionIds: leaders,
          isDraw,
          resolvedAt: new Date().toISOString(),
          resolvedBy: 'consensus',
        };
      }
    }

    results.push({
      id: decisionId,
      revision: latest.revision,
      authorId: latest.authorId,
      title: latest.title,
      context: latest.context,
      options: latest.options,
      mode: latest.mode,
      status,
      createdAt: new Date(first.at).toISOString(),
      updatedAt: new Date(latest.at).toISOString(),
      tallies,
      totalHumanVoters: humanVotersCount,
      totalAgentVoters: agentVotersCount,
      leadingOptionIds: leaders,
      isDraw,
      outcome,
    });
  }

  // Oldest decisions first.
  return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * Compact decisions and votes when total operations exceed threshold.
 * Retains only the latest decision operation and latest vote per member.
 */
export function compactDecisions(
  decisions: DecisionPacket[],
  votes: VotePacket[]
): { decisions: DecisionPacket[]; votes: VotePacket[] } {
  // Retain newest decision operation per decisionId (unless removed).
  const latestDecisions = new Map<string, DecisionPacket>();
  for (const pkt of decisions) {
    const existing = latestDecisions.get(pkt.body.decisionId);
    if (!existing || compareOps(pkt.body, existing.body) > 0) {
      latestDecisions.set(pkt.body.decisionId, pkt);
    }
  }

  // Filter out removed decisions.
  const activeDecisionIds = new Set<string>();
  const compactedDecisions: DecisionPacket[] = [];
  for (const pkt of latestDecisions.values()) {
    if (!pkt.body.removed) {
      activeDecisionIds.add(pkt.body.decisionId);
      compactedDecisions.push(pkt);
    }
  }

  // Retain highest revision vote per (decisionId, memberId) for active decisions.
  const latestVotes = new Map<string, VotePacket>();
  for (const pkt of votes) {
    if (!activeDecisionIds.has(pkt.body.decisionId)) continue;
    const key = `${pkt.body.decisionId}:${pkt.body.memberId}`;
    const existing = latestVotes.get(key);
    if (!existing || compareOps(pkt.body, existing.body) > 0) {
      latestVotes.set(key, pkt);
    }
  }

  return {
    decisions: compactedDecisions.sort((a, b) => compareOps(a.body, b.body)),
    votes: Array.from(latestVotes.values()).sort((a, b) => compareOps(a.body, b.body)),
  };
}
