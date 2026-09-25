import { expect, test } from 'bun:test';
import { compactBoard, foldBoard, syncChunks, taskBody, validTaskBody, type TaskBody } from '../../src/browser/board';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), sam = crypto.randomUUID(), codex = crypto.randomUUID();
const device = 'a'.repeat(64);
const op = (memberId: string, change: Parameters<typeof taskBody>[0]['change'], current?: ReturnType<typeof foldBoard>[number], extra: Partial<TaskBody> = {}) =>
  ({ ...taskBody({ roomId, deviceId: device, memberId, current, change }), ...extra });

test('the last revision of each task wins, and every device folds concurrent edits the same way', () => {
  const create = op(alex, { title: 'Fix header', assigneeId: codex });
  const [task] = foldBoard([create]);
  expect(task).toMatchObject({ title: 'Fix header', status: 'todo', assigneeId: codex, assignedBy: alex, assignedRevision: 1, createdBy: alex, revision: 1 });
  // Two people edit revision 1 at once: both produce revision 2; time, then operation id, picks the same winner everywhere.
  const a = op(alex, { status: 'doing' }, task, { at: 2000, id: '00000000-0000-4000-8000-000000000001' });
  const b = op(sam, { notes: 'use flex' }, task, { at: 2000, id: '00000000-0000-4000-8000-000000000002' });
  const one = foldBoard([create, a, b]), other = foldBoard([b, create, a]);
  expect(one).toEqual(other);
  expect(one[0]).toMatchObject({ revision: 2, notes: 'use flex', status: 'todo', updatedBy: sam });
  const next = op(sam, { status: 'done', assigneeId: null }, one[0]);
  expect(foldBoard([create, a, b, next])[0]).toMatchObject({ revision: 3, status: 'done', notes: 'use flex' });
  expect(foldBoard([create, a, b, next])[0].assigneeId).toBeUndefined();
});

test('a removed task disappears for everyone, and boards keep creation order', () => {
  const first = op(alex, { title: 'First' }, undefined, { at: 1000 }), second = op(sam, { title: 'Second' }, undefined, { at: 2000 });
  expect(foldBoard([second, first]).map(t => t.title)).toEqual(['First', 'Second']);
  const removed = { ...taskBody({ roomId, deviceId: device, memberId: sam, current: foldBoard([first])[0], change: {}, removed: true }) };
  expect(foldBoard([first, second, removed]).map(t => t.title)).toEqual(['Second']);
});

test('operations are validated, and board exchange stays under the data channel limit', () => {
  const good = op(alex, { title: 'Valid', notes: 'n'.repeat(2000) });
  expect(validTaskBody(good, roomId)).toBe(true);
  expect(validTaskBody({ ...good, roomId: crypto.randomUUID() }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, status: 'blocked' }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, title: ' ' }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, notes: 'n'.repeat(2001) }, roomId)).toBe(false);
  expect(validTaskBody({ ...good, assigneeId: 'someone' }, roomId)).toBe(false);
  expect(() => taskBody({ roomId, deviceId: device, memberId: alex, change: { title: '' } })).toThrow('title');
  const packets = Array.from({ length: 40 }, () => ({ body: op(alex, { title: 'T', notes: 'x'.repeat(1900) }), signature: 's'.repeat(88) }));
  const chunks = syncChunks(roomId, packets);
  expect(chunks.length).toBeGreaterThan(1);
  expect(chunks.flatMap(c => c.ops)).toHaveLength(40);
  for (const chunk of chunks) expect(JSON.stringify(chunk).length).toBeLessThan(20_000);
});

test("Gemini's review: removal wins, clocks never decide, and a losing edit does not take assignment credit", () => {
  const create = op(alex, { title: 'Review', assigneeId: codex }, undefined, { at: 1000 });
  const [task] = foldBoard([create]);
  // 2. A removal wins over a simultaneous edit, and over a later edit made without seeing the removal.
  const removal = { ...taskBody({ roomId, deviceId: device, memberId: sam, current: task, change: {}, removed: true }), at: 1500, id: '00000000-0000-4000-8000-000000000001' };
  const edit = op(alex, { notes: 'later' }, task, { at: 9000, id: 'ffffffff-ffff-4fff-bfff-ffffffffffff' });
  expect(foldBoard([create, removal, edit])).toEqual([]);
  expect(foldBoard([create, edit, op(alex, { status: 'done' }, foldBoard([create, edit])[0]), removal])).toEqual([]);
  // 3. At the same revision the operation id decides, not the clock: a device far in the future still loses.
  const future = op(sam, { title: 'Future clock' }, task, { at: 9_999_999_999_999, id: '00000000-0000-4000-8000-00000000000a' });
  const now = op(alex, { title: 'Normal clock' }, task, { at: 2000, id: '00000000-0000-4000-8000-00000000000b' });
  expect(foldBoard([create, future, now])[0].title).toBe('Normal clock');
  // 5. A losing concurrent reassignment does not move the credit away from whoever assigned the current assignee.
  const reassign = op(sam, { assigneeId: sam }, task, { id: '00000000-0000-4000-8000-000000000001' });
  const retitle = op(alex, { title: 'Review v2' }, task, { id: '00000000-0000-4000-8000-000000000002' });
  expect(foldBoard([create, reassign, retitle])[0]).toMatchObject({ title: 'Review v2', assigneeId: codex, assignedBy: alex, assignedRevision: 1 });
});

test('compaction keeps the same board with far fewer operations', () => {
  let ops: TaskBody[] = [];
  const apply = (memberId: string, change: Parameters<typeof taskBody>[0]['change'], taskId?: string, removed = false) => {
    const current = taskId ? foldBoard(ops).find(t => t.id === taskId) : undefined;
    const body = taskBody({ roomId, deviceId: device, memberId, current, taskId, change, removed });
    ops.push(body); return body.taskId;
  };
  const a = apply(alex, { title: 'A', assigneeId: codex }), b = apply(sam, { title: 'B' }), c = apply(sam, { title: 'C' });
  for (let i = 0; i < 120; i++) apply(i % 2 ? alex : sam, { status: (['todo', 'doing', 'done'] as const)[i % 3], notes: `step ${i}` }, a);
  apply(sam, { assigneeId: sam }, b); apply(alex, { assigneeId: null }, b); apply(alex, { assigneeId: sam }, b); apply(sam, { status: 'doing' }, b);
  apply(alex, {}, c, true);
  const packets = ops.map(body => ({ body, signature: 's' }));
  const compacted = compactBoard(packets);
  expect(compacted.length).toBeLessThan(40);
  expect(foldBoard(compacted.map(p => p.body))).toEqual(foldBoard(ops));
  expect(foldBoard(ops).find(t => t.id === b)).toMatchObject({ assigneeId: sam, assignedBy: alex });
  expect(compactBoard(compacted)).toEqual(compacted);
});

test("Copilot's review: a late concurrent edit decides the same way on compacted and full boards", () => {
  const ops: TaskBody[] = [op(alex, { title: 'Late edits', assigneeId: codex })];
  for (let i = 0; i < 80; i++) ops.push(op(i % 2 ? alex : sam, { notes: `step ${i}` }, foldBoard(ops)[0]));
  const compacted = compactBoard(ops.map(body => ({ body, signature: 's' }))).map(p => p.body);
  expect(compacted.length).toBeLessThan(ops.length);
  // An offline peer's edit made at an older revision reassigns the task; its id loses or wins against the kept winner.
  const at = ops[ops.length - 5];
  for (const id of ['00000000-0000-4000-8000-000000000000', 'ffffffff-ffff-4fff-bfff-ffffffffffff']) {
    const late = { ...at, id, memberId: sam, assigneeId: sam, notes: 'offline edit' };
    expect(foldBoard([...compacted, late])).toEqual(foldBoard([...ops, late]));
  }
});
