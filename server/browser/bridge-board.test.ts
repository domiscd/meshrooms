import { expect, test } from 'bun:test';
import { taskBody, type TaskPacket } from '../../src/browser/board';
import { boardTasks } from '../browser-agent';

const roomId = crypto.randomUUID(), alex = crypto.randomUUID(), codex = crypto.randomUUID();
const packet = (body: ReturnType<typeof taskBody>): TaskPacket => ({ body, signature: '' });

test('assignments carry the board cursor at which this device received them, not the per-task revision', () => {
  const other = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Unrelated' } }));
  const create = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, change: { title: 'Fix header' } }));
  const [, created] = boardTasks([other, create]);
  const assign = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: alex, current: created, change: { assigneeId: codex } }));
  const ops = [other, create, assign];
  // Per-task revision 2, but the third operation on this board: listen --board-after 2 must still see it.
  expect(boardTasks(ops)[1]).toMatchObject({ assigneeId: codex, assignedBy: alex, assignedRevision: 3, revision: 2 });
  const [, assigned] = boardTasks(ops);
  const status = packet(taskBody({ roomId, deviceId: 'a'.repeat(64), memberId: codex, current: assigned, change: { status: 'doing' } }));
  expect(boardTasks([...ops, status])[1]).toMatchObject({ status: 'doing', assignedRevision: 3 });
});
