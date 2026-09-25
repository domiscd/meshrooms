import { TASK_STATUSES, type Task, type TaskStatus } from '../collab';

/**
 * Browser-room task board. The room service never sees tasks: each change is a signed operation carrying the task's
 * whole state at one revision, sent between devices like a message. Every device folds the same operations the same
 * way, so boards converge; peers exchange their operations when they connect so later arrivals see current tasks.
 */
export type TaskBody = {
  kind: 'task'; roomId: string; id: string; deviceId: string; memberId: string; at: number;
  taskId: string; revision: number; title: string; notes: string; status: TaskStatus; assigneeId: string | null; removed?: true;
};
export type TaskPacket = { body: TaskBody; signature: string };
/** Unsigned envelope for exchanging a board; every operation inside is verified against its own author's device. */
export type BoardSync = { kind: 'board'; roomId: string; ops: TaskPacket[] };
export type TaskChange = { title?: string; notes?: string; status?: TaskStatus; assigneeId?: string | null };

export const MAX_TASK_OPS = 2000;
/** Data channel messages over 20,000 characters are dropped, so exchanged boards are split well below that. */
export const SYNC_CHUNK_CHARS = 15_000;
const id = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export function validTaskBody(b: any, roomId: string): b is TaskBody {
  return !!b && b.kind === 'task' && b.roomId === roomId && id(b.id) && id(b.taskId) && id(b.memberId)
    && typeof b.deviceId === 'string' && /^[a-f0-9]{64}$/.test(b.deviceId)
    && Number.isSafeInteger(b.at) && b.at > 0 && Number.isSafeInteger(b.revision) && b.revision >= 1 && b.revision <= 1_000_000
    && typeof b.title === 'string' && !!b.title.trim() && b.title.length <= 120 && typeof b.notes === 'string' && b.notes.length <= 2000
    && TASK_STATUSES.includes(b.status) && (b.assigneeId === null || id(b.assigneeId)) && (b.removed === undefined || b.removed === true);
}

/** Operations of one task in the order every device applies them: revision, then time, then operation id. */
function compare(a: TaskBody, b: TaskBody) { return a.revision - b.revision || a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }

/** The current board: the last operation of each task wins; removed tasks disappear. Oldest tasks first. */
export function foldBoard(ops: TaskBody[]): Task[] {
  const byTask = new Map<string, TaskBody[]>();
  for (const op of ops) byTask.set(op.taskId, [...(byTask.get(op.taskId) || []), op]);
  const tasks: (Task & { createdAt: number })[] = [];
  for (const [taskId, list] of byTask) {
    list.sort(compare);
    let assignee: string | null = null, assignedBy: string | undefined, assignedRevision: number | undefined;
    for (const op of list) if (op.assigneeId !== assignee) { assignee = op.assigneeId; assignedBy = op.assigneeId ? op.memberId : undefined; assignedRevision = op.assigneeId ? op.revision : undefined; }
    const last = list.at(-1)!;
    if (last.removed) continue;
    tasks.push({ id: taskId, title: last.title, notes: last.notes, status: last.status, ...(last.assigneeId ? { assigneeId: last.assigneeId, assignedBy, assignedRevision } : {}),
      createdBy: list[0].memberId, updatedBy: last.memberId, updatedAt: new Date(last.at).toISOString(), revision: last.revision, createdAt: list[0].at });
  }
  return tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)).map(({ createdAt: _, ...task }) => task);
}

/** The unsigned body for creating (no current task) or changing a task; the caller signs and sends it. */
export function taskBody(input: { roomId: string; deviceId: string; memberId: string; current?: Task; taskId?: string; change: TaskChange; removed?: boolean }): TaskBody {
  const { current, change } = input;
  const title = (change.title ?? current?.title ?? '').trim(), notes = (change.notes ?? current?.notes ?? '').trim();
  if (!title || title.length > 120) throw new Error('Give the task a title of up to 120 characters.');
  if (notes.length > 2000) throw new Error('Keep task notes to 2,000 characters.');
  return { kind: 'task', roomId: input.roomId, id: crypto.randomUUID(), deviceId: input.deviceId, memberId: input.memberId, at: Date.now(),
    taskId: current?.id ?? input.taskId ?? crypto.randomUUID(), revision: (current?.revision ?? 0) + 1, title, notes,
    status: change.status ?? current?.status ?? 'todo', assigneeId: change.assigneeId !== undefined ? change.assigneeId : current?.assigneeId ?? null,
    ...(input.removed ? { removed: true as const } : {}) };
}

/** Split a board into sync envelopes that stay under the data channel limit. */
export function syncChunks(roomId: string, ops: TaskPacket[]): BoardSync[] {
  const chunks: BoardSync[] = []; let current: TaskPacket[] = [], size = 0;
  for (const op of ops) {
    const length = JSON.stringify(op).length;
    if (current.length && size + length > SYNC_CHUNK_CHARS) { chunks.push({ kind: 'board', roomId, ops: current }); current = []; size = 0; }
    current.push(op); size += length;
  }
  if (current.length) chunks.push({ kind: 'board', roomId, ops: current });
  return chunks;
}
