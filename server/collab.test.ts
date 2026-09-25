import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import { createHandler } from './http';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';
import { tokenHash } from './model';
import { evaluateWake, mentionSegments, mentionedIds } from '../src/collab';
import type { Message } from '../src/room';

const people = [
  { id: 'igor', name: 'Igor', role: 'human' as const },
  { id: 'codex', name: 'Codex', role: 'agent' as const },
  { id: 'codex-cli', name: 'Codex CLI', role: 'agent' as const },
  { id: 'grok', name: 'Grok', role: 'agent' as const },
];

test('mentions match roster names at word boundaries, prefer longer names, and expand @agents', () => {
  expect(mentionedIds('@codex can you check?', people)).toEqual(['codex']);
  expect(mentionedIds('Ask @Codex CLI, not the other one', people)).toEqual(['codex-cli']);
  expect(mentionedIds('@Codex and @Codex CLI', people)).toEqual(['codex', 'codex-cli']);
  expect(mentionedIds('mail igor@codex.dev or @Codexes', people)).toEqual([]);
  expect(mentionedIds('(@Grok) thoughts?', people)).toEqual(['grok']);
  expect(mentionedIds('@agents please review', people)).toEqual(['codex', 'codex-cli', 'grok']);
  expect(mentionSegments('Hi @Grok!', people)).toEqual([{ text: 'Hi ' }, { text: '@Grok', mention: true }, { text: '!' }]);
});

function message(id: string, authorId: string, text: string, extra: Partial<Message> = {}): Message {
  const author = people.find(p => p.id === authorId)!;
  return { id, authorId, author: author.name, role: author.role, text, time: new Date().toISOString(), mentions: mentionedIds(text, people), ...extra };
}

test('humans-first wakes an agent only when a person addresses it, and keeps observed messages as context', () => {
  const messages = [message('m1', 'igor', 'Morning, just people for now')];
  const room = { floor: 'humans-first' as const, participants: people, messages, tasks: [], boardRevision: 0 };
  expect(evaluateWake(room, 'codex', undefined, 0)).toMatchObject({ state: 'history', cursor: 'm1', addressed: [] });
  messages.push(message('m2', 'igor', 'Still chatting'), message('m3', 'grok', '@Codex I disagree'), message('m4', 'codex', 'My own note'));
  expect(evaluateWake(room, 'codex', 'm1', 0)).toMatchObject({ state: 'waiting', cursor: 'm1', addressed: [] });
  messages.push(message('m5', 'igor', '@Codex what do you think?'));
  const woken = evaluateWake(room, 'codex', 'm1', 0);
  expect(woken).toMatchObject({ state: 'addressed', cursor: 'm5', addressed: ['m5'] });
  expect(woken.messages.map(m => m.id)).toEqual(['m2', 'm3', 'm4', 'm5']);
  // Replying to an agent's message addresses it; @agents addresses every agent.
  messages.push(message('m6', 'igor', 'Good point', { replyTo: 'm4' }), message('m7', 'igor', '@agents stand by'));
  expect(evaluateWake(room, 'codex', 'm5', 0).addressed).toEqual(['m6', 'm7']);
  expect(evaluateWake(room, 'grok', 'm5', 0).addressed).toEqual(['m7']);
  expect(() => evaluateWake(room, 'codex', 'missing', 0)).toThrow('cursor');
});

test('open floor wakes on every human message but agents only on explicit address; assignments wake once', () => {
  const messages = [message('m1', 'igor', 'Hello'), message('m2', 'grok', 'Hi all'), message('m3', 'grok', '@Codex over to you')];
  const task = { id: randomUUID(), title: 'Review', notes: '', status: 'todo' as const, assigneeId: 'codex', assignedBy: 'igor', assignedRevision: 3,
    createdBy: 'igor', updatedBy: 'igor', updatedAt: new Date().toISOString(), revision: 1 };
  const open = { floor: 'open' as const, participants: people, messages, tasks: [task], boardRevision: 3 };
  expect(evaluateWake(open, 'codex', 'm1', 3).addressed).toEqual(['m3']);
  expect(evaluateWake({ ...open, floor: 'humans-first' }, 'codex', 'm1', 3).state).toBe('waiting');
  expect(evaluateWake({ ...open, messages: messages.slice(0, 1) }, 'codex', undefined, 3).addressed).toEqual(['m1']);
  const assigned = evaluateWake({ ...open, floor: 'humans-first' }, 'codex', 'm3', 2);
  expect(assigned).toMatchObject({ state: 'addressed', cursor: 'm3', boardCursor: 3 }); expect(assigned.tasks.map(t => t.id)).toEqual([task.id]);
  expect(evaluateWake({ ...open, floor: 'humans-first', tasks: [{ ...task, assignedBy: 'grok' }] }, 'codex', 'm3', 2).state).toBe('waiting');
  expect(evaluateWake({ ...open, tasks: [{ ...task, status: 'done' }] }, 'codex', 'm3', 2).state).toBe('waiting');
});

function memoryNode(records = new Map<string, string>()) {
  return { records, node: new LocalNode({ read: key => records.get(key) ?? null, write: (key, value) => { records.set(key, value); }, close() {} }) };
}
function agentRoom(node: LocalNode, agentName = 'Codex') {
  const secret = randomBytes(32).toString('base64url'), roomId = randomUUID();
  node.prepareRoom({ requestId: roomId, title: 'Floor', agentName, credentialHash: tokenHash(secret) });
  node.completeSetup({ requestId: randomUUID(), humanName: 'Igor', machineName: 'Test', startAtLogin: false, intentId: roomId });
  return { roomId, agent: node.authenticateAgent(secret)! };
}

test('the node enforces humans-first sends and lets the owner open the floor', () => {
  const { node } = memoryNode(); const { roomId, agent } = agentRoom(node);
  try {
    const send = (text: string, replyTo?: string, principal = agent) => node.send({ roomId, requestId: randomUUID(), text, replyTo }, principal);
    expect(node.snapshot().rooms[0].floor).toBe('humans-first');
    expect(() => send('Jumping in')).toThrow('humans-first');
    const chat = send('Just talking', undefined, node.owner);
    expect(() => send('Replying anyway', chat.messageId)).toThrow('humans-first');
    const ask = send('@Codex what do you think?', undefined, node.owner);
    expect(node.snapshot().rooms[0].messages.at(-1)?.mentions).toEqual([agent.participantId]);
    const answer = send('Here is my view', ask.messageId);
    send('And one more detail', ask.messageId);
    const followUp = send('Thanks, why?', answer.messageId, node.owner);
    send('Because…', followUp.messageId);
    expect(() => node.setFloor({ roomId, requestId: randomUUID(), floor: 'open' }, agent)).toThrow('human session');
    expect(() => node.setFloor({ roomId, requestId: randomUUID(), floor: 'loud' })).toThrow('humans-first or open');
    node.setFloor({ roomId, requestId: randomUUID(), floor: 'open' });
    expect(node.snapshot(agent).rooms[0].floor).toBe('open');
    send('Unprompted update');
  } finally { node.close(); }
});

test('task board commands are shared, idempotent, revision-checked, persisted, and let assigned agents speak', () => {
  const { node, records } = memoryNode(); const { roomId, agent } = agentRoom(node);
  const create = { roomId, requestId: randomUUID(), title: 'Write the release notes', assigneeId: agent.participantId };
  const created = node.createTask(create);
  expect(node.createTask(create)).toEqual(created);
  expect(() => node.createTask({ ...create, title: 'Different' })).toThrow('different content');
  expect(() => node.createTask({ roomId, requestId: randomUUID(), title: 'Nobody', assigneeId: randomUUID() })).toThrow('participant on this machine');
  const board = node.snapshot(agent).rooms[0];
  expect(board.boardRevision).toBe(1);
  expect(board.tasks).toMatchObject([{ id: created.taskId, status: 'todo', assigneeId: agent.participantId, assignedBy: node.owner.participantId, assignedRevision: 1 }]);
  // A person's assignment grants the agent the floor for progress reports.
  node.send({ roomId, requestId: randomUUID(), text: 'Starting on the notes' }, agent);
  const update = { roomId, requestId: randomUUID(), taskId: created.taskId, revision: 1, status: 'doing' };
  const moved = node.updateTask(update, agent); expect(moved).toEqual({ taskId: created.taskId, revision: 2 });
  expect(node.updateTask(update, agent)).toEqual(moved);
  expect(() => node.updateTask({ ...update, requestId: randomUUID() }, agent)).toThrow('changed since');
  expect(() => node.updateTask({ roomId, requestId: randomUUID(), taskId: created.taskId, revision: 2, status: 'blocked' })).toThrow('todo, doing, or done');
  node.updateTask({ roomId, requestId: randomUUID(), taskId: created.taskId, revision: 2, status: 'done', notes: 'Merged in #12' }, agent);
  expect(() => node.send({ roomId, requestId: randomUUID(), text: 'Anything else?' }, agent)).toThrow('humans-first');
  const second = node.createTask({ roomId, requestId: randomUUID(), title: 'Temporary' }, agent);
  node.removeTask({ roomId, requestId: randomUUID(), taskId: second.taskId, revision: 1 });
  node.close();
  const restored = memoryNode(records).node;
  try {
    const room = restored.snapshot().rooms[0];
    expect(room.boardRevision).toBe(5);
    expect(room.tasks).toMatchObject([{ id: created.taskId, status: 'done', notes: 'Merged in #12', revision: 3, updatedBy: agent.participantId }]);
  } finally { restored.close(); }
});

test('HTTP exposes floor and task commands for the owner session', async () => {
  const { node } = memoryNode(); const { roomId } = agentRoom(node);
  const token = 'test-control-token-32-bytes-minimum-length';
  const handle = createHandler({ node, origins: ['http://127.0.0.1:4318'], distDir: 'dist', dataDir: 'test-store', access: new NodeAccess(token, node),
    startup: testStartupManager(), runtime: { apiVersion: 2, instanceId: 'test-instance', pid: process.pid }, proof: () => 'test-proof' });
  const post = (path: string, body: unknown) => handle(new Request(`http://127.0.0.1:4318/api/node/${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  try {
    expect((await post('rooms/floor', { roomId, requestId: randomUUID(), floor: 'open' })).status).toBe(200);
    const created = await post('tasks', { roomId, requestId: randomUUID(), title: 'Board over HTTP' });
    expect(created.status).toBe(201); const { taskId, revision } = await created.json();
    expect((await post('tasks/update', { roomId, requestId: randomUUID(), taskId, revision, status: 'doing' })).status).toBe(200);
    expect((await post('tasks/remove', { roomId, requestId: randomUUID(), taskId, revision })).status).toBe(409);
    expect((await post('tasks/remove', { roomId, requestId: randomUUID(), taskId, revision: 2 })).status).toBe(200);
    expect(node.snapshot().rooms[0]).toMatchObject({ floor: 'open', tasks: [], boardRevision: 3 });
  } finally { node.close(); }
});
