import { expect, test } from 'bun:test';
import { foldBoard, syncChunks, taskBody, validTaskBody, type TaskBody } from '../../src/browser/board';

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
