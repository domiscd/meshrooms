import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createHandler } from './http';
import { LocalNode } from './node';
import { NodeAccess } from './access';
import { testStartupManager } from './startup';

function app() {
  const values = new Map<string, string>();
  const node = new LocalNode({ read: key => values.get(key) ?? null, write: (key, value) => { values.set(key, value); }, close() {} });
  const token = 'test-control-token-32-bytes-minimum-length';
  const handle = createHandler({ node, origins: ['http://127.0.0.1:4318'], distDir: 'dist', dataDir: 'test-store', access: new NodeAccess(token, node),
    startup: testStartupManager(), runtime: { apiVersion: 2, instanceId: 'test-instance', pid: process.pid }, proof: () => 'test-proof' });
  const headers = { Authorization: `Bearer ${token}` };
  const send = (path: string, body: unknown, extra: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:4318/api/node/${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) }));
  return { node, handle, send, headers };
}

test('HTTP rooms and history are explicit and cross-site commands cannot create rooms', async () => {
  const { handle, send, headers } = app();
  expect((await send('rooms', { title: 'No', requestId: randomUUID() }, { Origin: 'https://other.example' })).status).toBe(403);
  expect((await handle(new Request('http://127.0.0.1:4318/api/node/snapshot', { headers: { Host: 'rebinding.example:4318' } }))).status).toBe(403);
  const a = await (await send('rooms', { title: 'A', requestId: randomUUID() })).json();
  const b = await (await send('rooms', { title: 'B', requestId: randomUUID() })).json();
  const command = { roomId: a.roomId, text: 'Only A', requestId: randomUUID() };
  const sent = await (await send('messages', command)).json();
  expect(await (await send('messages', command)).json()).toEqual(sent);
  expect((await send('messages', { roomId: b.roomId, text: 'Invalid reply', requestId: randomUUID(), replyTo: sent.messageId })).status).toBe(400);
  const snapshot = await (await handle(new Request('http://127.0.0.1:4318/api/node/snapshot', { headers }))).json();
  expect(snapshot.rooms.map((room: any) => room.messages.map((message: any) => message.text))).toEqual([['Only A'], []]);
});

test('SSE subscribes to the node; aborting a view preserves room state', async () => {
  const { node, handle, send, headers } = app();
  const abort = new AbortController();
  const response = await handle(new Request('http://127.0.0.1:4318/api/node/events?view=test', { signal: abort.signal, headers }));
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('"rooms":[]');
  await send('rooms', { title: 'Persistent ownership', requestId: randomUUID() });
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('Persistent ownership');
  abort.abort(); await reader.cancel();
  expect(node.snapshot().rooms).toHaveLength(1);
});
