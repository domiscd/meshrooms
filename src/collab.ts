import type { Message, Participant } from './room';

/** Who may speak unprompted. Humans-first rooms keep agents listening until a person addresses them. */
export type Floor = 'humans-first' | 'open';
export const FLOORS: Floor[] = ['humans-first', 'open'];
export const DEFAULT_FLOOR: Floor = 'humans-first';

export type TaskStatus = 'todo' | 'doing' | 'done';
export const TASK_STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];
export type Task = {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  assigneeId?: string;
  /** Who set the current assignee, and the board revision at which it happened. */
  assignedBy?: string;
  assignedRevision?: number;
  createdBy: string;
  updatedBy: string;
  updatedAt: string;
  revision: number;
};

/** `@agents` addresses every agent in the room. */
export const AGENTS_MENTION = 'agents';

const boundary = (char: string | undefined) => char === undefined || !/[\p{L}\p{N}_]/u.test(char);

/**
 * Participants addressed by `@Name` in text, matched case-insensitively against the room roster.
 * Longer names win, so `@Codex CLI` does not also count as `@Codex` when both exist.
 */
export function mentionedIds(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[]): string[] {
  if (!text.includes('@')) return [];
  const lower = text.toLowerCase(); const taken = new Array<boolean>(text.length).fill(false); const found = new Set<string>();
  const names = [...participants.map(p => ({ key: p.name.toLowerCase(), ids: [p.id] })),
    { key: AGENTS_MENTION, ids: participants.filter(p => p.role === 'agent').map(p => p.id) }].sort((a, b) => b.key.length - a.key.length);
  for (const { key, ids } of names) {
    let from = 0;
    while ((from = lower.indexOf(`@${key}`, from)) >= 0) {
      const end = from + key.length + 1;
      if (boundary(text[from - 1]) && boundary(text[end]) && !taken[from]) {
        for (let i = from; i < end; i++) taken[i] = true;
        ids.forEach(id => found.add(id));
      }
      from = end;
    }
  }
  return participants.map(p => p.id).filter(id => found.has(id));
}

/** Split text into plain and mention segments for display. */
export function mentionSegments(text: string, participants: Pick<Participant, 'id' | 'name' | 'role'>[]): { text: string; mention?: boolean }[] {
  if (!text.includes('@')) return [{ text }];
  const keys = [...new Set([...participants.map(p => p.name.toLowerCase()), AGENTS_MENTION])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase(); const segments: { text: string; mention?: boolean }[] = []; let plain = 0; let i = 0;
  while ((i = lower.indexOf('@', i)) >= 0) {
    const key = boundary(text[i - 1]) ? keys.find(k => lower.startsWith(k, i + 1) && boundary(text[i + 1 + k.length])) : undefined;
    if (!key) { i++; continue; }
    if (i > plain) segments.push({ text: text.slice(plain, i) });
    segments.push({ text: text.slice(i, i + key.length + 1), mention: true });
    plain = i = i + key.length + 1;
  }
  if (plain < text.length) segments.push({ text: text.slice(plain) });
  return segments;
}

type RoomView = { floor?: Floor; messages: Message[]; participants: Pick<Participant, 'id' | 'role'>[]; tasks?: Task[] };

/** A message addresses a participant by mentioning them or by replying to one of their messages. */
export function addresses(message: Message, participantId: string, messages: Message[]): boolean {
  if (message.authorId === participantId) return false;
  if (message.mentions?.includes(participantId)) return true;
  return !!message.replyTo && messages.find(m => m.id === message.replyTo)?.authorId === participantId;
}

const roleOf = (room: RoomView, id: string | undefined) => room.participants.find(p => p.id === id)?.role;

/** Whether a message should wake an agent under the room's floor policy. Agents never wake themselves. */
export function wakes(room: RoomView, message: Message, agentId: string): boolean {
  if (message.authorId === agentId) return false;
  if ((room.floor ?? DEFAULT_FLOOR) === 'open' && message.role === 'human') return true;
  if ((room.floor ?? DEFAULT_FLOOR) === 'humans-first' && message.role !== 'human') return false;
  return addresses(message, agentId, room.messages);
}

/** Whether an assignment should wake its agent: from a person in humans-first rooms, from anyone else in open rooms. */
export function assignmentWakes(room: RoomView, task: Task, agentId: string): boolean {
  if (task.assigneeId !== agentId || task.status === 'done' || !task.assignedBy || task.assignedBy === agentId) return false;
  return (room.floor ?? DEFAULT_FLOOR) === 'open' || roleOf(room, task.assignedBy) === 'human';
}

/** An agent may speak when replying to a message that woke it, or while holding open work a person assigned. */
export function mayAgentSpeak(room: RoomView, agentId: string, replyTo: string | undefined): boolean {
  if ((room.floor ?? DEFAULT_FLOOR) === 'open') return true;
  const target = replyTo ? room.messages.find(m => m.id === replyTo) : undefined;
  if (target && wakes(room, target, agentId)) return true;
  return (room.tasks || []).some(task => assignmentWakes(room, task, agentId));
}

export type WakeResult = {
  /** `history`: first read without a cursor. `addressed`: something needs this agent. `waiting`: only observed messages. */
  state: 'history' | 'addressed' | 'waiting';
  /** Every message after the cursor, including observed ones, so the agent has the conversation it was listening to. */
  messages: Message[];
  addressed: string[];
  tasks: Task[];
  cursor?: string;
  boardCursor?: number;
};

/**
 * Evaluate one snapshot for an agent. The message cursor only advances when the agent is woken,
 * so unaddressed messages accumulate as context rather than being consumed silently.
 */
export function evaluateWake(room: RoomView & { boardRevision?: number }, agentId: string, after: string | undefined, boardAfter: number | undefined): WakeResult {
  const index = after ? room.messages.findIndex(m => m.id === after) : -1;
  if (after && index < 0) throw new Error('The supplied cursor is not in this room. Read the room to establish a cursor.');
  const unseen = room.messages.slice(index + 1);
  const addressed = unseen.filter(m => wakes(room, m, agentId)).map(m => m.id);
  const tasks = boardAfter === undefined ? [] : (room.tasks || []).filter(t => (t.assignedRevision ?? 0) > boardAfter && assignmentWakes(room, t, agentId));
  const boardCursor = room.boardRevision ?? boardAfter;
  if (!after && unseen.length) return { state: 'history', messages: unseen, addressed, tasks, cursor: unseen.at(-1)!.id, boardCursor };
  if (addressed.length || tasks.length) return { state: 'addressed', messages: unseen, addressed, tasks, cursor: unseen.at(-1)?.id ?? after, boardCursor };
  return { state: 'waiting', messages: unseen, addressed: [], tasks: [], cursor: after, boardCursor: boardAfter };
}
