import { expect, test } from 'bun:test';
import { base64, browserProtocol, encode, type Command, type RoomStatus } from '../../src/browser/protocol';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { testDirectory } from '../test-directory';
import { join } from 'node:path';

const origin = 'http://127.0.0.1:4320';

test('proxy quotas isolate real clients and ignore forged forwarding from direct clients', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  let now = Date.now();
  const handler = browserHandler(lobby, origin, '.', { trustLoopbackProxy: true, apiLimit: 2, revision: 'test-revision', now: () => now });
  const health = (ip: string, remote = '127.0.0.1') => handler(new Request(`${origin}/api/lobby/health`, { headers: { 'x-real-ip': ip } }), remote);
  try {
    expect(await (await health('192.0.2.1')).json()).toEqual({ ok: true, revision: 'test-revision' });
    expect((await health('192.0.2.1')).status).toBe(200);
    expect((await health('192.0.2.1')).status).toBe(429);
    expect((await health('192.0.2.2')).status).toBe(200);
    expect((await health('192.0.2.3', '192.0.2.20')).status).toBe(200);
    expect((await health('192.0.2.4', '192.0.2.20')).status).toBe(200);
    expect((await health('192.0.2.5', '192.0.2.20')).status).toBe(429);
    now += 60_000;
    expect((await health('192.0.2.1')).status).toBe(200);
  } finally { lobby.close(); }
});

test('creation quotas leave existing-room access available and bound rooms per host device', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  const handler = browserHandler(lobby, origin, '.', { createLimit: 1 });
  try {
    const host = await client(lobby), room = crypto.randomUUID();
    const send = async (id: string) => handler(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(await host.signed('create', id, { title: 'QA', name: 'Host', label: 'Browser' })) }), '192.0.2.1');
    expect((await send(room)).status).toBe(200);
    expect((await send(crypto.randomUUID())).status).toBe(429);
    expect((await handler(new Request(`${origin}/api/lobby/rooms/${room}`), '192.0.2.1')).status).toBe(200);
    for (let i = 1; i < 8; i++) await host.send('create', crypto.randomUUID(), { title: 'QA', name: 'Host', label: 'Browser' });
    await expect(host.send('create', crypto.randomUUID(), { title: 'QA', name: 'Host', label: 'Browser' })).rejects.toThrow('eight rooms');
  } finally { lobby.close(); }
});
async function client(lobby: BrowserLobby, clock = () => Date.now()) {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicKey = base64(await crypto.subtle.exportKey('raw', keys.publicKey));
  const session = crypto.randomUUID();
  const signed = async (action: Command['action'], roomId: string, payload: Record<string, unknown> = {}) => {
    const command: Command = { protocol: browserProtocol, origin, action, roomId, payload, id: crypto.randomUUID(), at: clock() };
    return { command, publicKey, signature: base64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, encode(command))) };
  };
  const send = async (action: Command['action'], roomId: string, payload = {}) => lobby.execute(await signed(action, roomId, payload));
  return { signed, send, status: async (roomId: string) => await send('status', roomId, { session }) as RoomStatus, session };
}

test('link is only a lobby; only host admission exposes members and allows signaling', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), stranger = await client(lobby);
    const room = crypto.randomUUID();
    await host.send('create', room, { title: 'Review', name: 'Alex', label: 'Desktop' });
    expect(lobby.publicRoom(room)).toEqual({ roomId: room, title: 'Review' });
    expect((await guest.status(room)).members).toBeUndefined();
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    const request = (await host.status(room)).requests![0];
    await expect(stranger.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('Only the host');
    await expect(guest.send('signal', room, {})).rejects.toThrow('admission');
    await host.send('decide', room, { requestId: request.id, admit: true });
    const joined = await guest.status(room);
    expect(joined.members).toHaveLength(2);
    expect(joined.requests).toBeUndefined();
    await expect(host.send('decide', room, { requestId: request.id, admit: true })).rejects.toThrow('no longer waiting');
    expect((await host.status(room)).members).toHaveLength(2);
  } finally { lobby.close(); }
});

test('companion enrollment binds to the approving identity; same display name creates no link', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), second = await client(lobby), impostor = await client(lobby);
    const room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await impostor.send('request', room, { name: 'Alex', label: 'Other', kind: 'person' });
    await second.send('request', room, { name: 'My device', label: 'Laptop', kind: 'companion' });
    const pending = (await second.status(room)).request!;
    const hostBefore = await host.status(room);
    expect(hostBefore.requests!.find(r => r.id === pending.id)!.code).toBeUndefined();
    await expect(host.send('decide', room, { requestId: pending.id, admit: true })).rejects.toThrow('Confirm this device');
    await expect(impostor.send('link', room, { code: pending.code })).rejects.toThrow('existing device');
    await host.send('link', room, { code: pending.code });
    const h = await host.status(room), s = await second.status(room);
    expect(s.memberId).toBe(h.memberId);
    expect(s.members).toHaveLength(1);
    expect(s.devices).toHaveLength(2);
    expect((await impostor.status(room)).memberId).toBeUndefined();
    await host.send('remove', room, { deviceId: s.deviceId });
    expect((await second.status(room)).memberId).toBeUndefined();
    expect((await host.status(room)).devices).toHaveLength(1);
  } finally { lobby.close(); }
});

test('signed commands resist forgery, replay changes, expiry, and cross-room approvals', async () => {
  let now = Date.now(); const lobby = new BrowserLobby(':memory:', { origin, now: () => now });
  try {
    const host = await client(lobby, () => now), guest = await client(lobby, () => now);
    const a = crypto.randomUUID(), b = crypto.randomUUID();
    const create = await host.signed('create', a, { title: 'A', name: 'Alex', label: 'Desktop' });
    await lobby.execute(create); expect(await lobby.execute(create)).toEqual({ roomId: a });
    await expect(lobby.execute({ ...create, command: { ...create.command, roomId: b } })).rejects.toThrow('authenticated');
    await guest.send('create', b, { title: 'B', name: 'Sam', label: 'Laptop' });
    await guest.send('request', a, { name: 'Sam', label: 'Laptop', kind: 'person' });
    const pending = (await host.status(a)).requests![0];
    await expect(guest.send('decide', a, { requestId: pending.id, admit: true })).rejects.toThrow('Only the host');
    await expect(guest.send('decide', b, { requestId: pending.id, admit: true })).rejects.toThrow('no longer waiting');
    now += 61_000;
    await expect(lobby.execute(create)).rejects.toThrow('expired');
    now += 600_000;
    expect((await guest.status(a)).request?.state).toBe('expired');
  } finally { lobby.close(); }
});

test('admission and request decisions survive coordinator restart', async () => {
  const dir = testDirectory('browser-admission'); const path = join(dir.path, 'state.sqlite');
  let lobby = new BrowserLobby(path, { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Persistent', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    const command = await guest.signed('status', room, { session: guest.session });
    const before = await lobby.execute(command) as RoomStatus;
    lobby.close(); lobby = new BrowserLobby(path, { origin });
    const after = await lobby.execute(command) as RoomStatus;
    expect(after.memberId).toBe(before.memberId); expect(after.devices).toHaveLength(2);
  } finally { lobby.close(); dir.cleanup(); }
});

test('HTTP protects origin, host, body limit, and private files', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const handle = browserHandler(lobby, origin, 'dist');
    expect((await handle(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { Origin: 'https://other.example' } }))).status).toBe(403);
    expect((await handle(new Request(`${origin}/rooms`, { headers: { Host: 'other.example' } }))).status).toBe(403);
    expect((await handle(new Request(`${origin}/.local/browser-rooms/admission.sqlite`))).status).toBe(404);
    expect((await handle(new Request(`${origin}/api/lobby`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: ' '.repeat(25_000) }))).status).toBe(413);
  } finally { lobby.close(); }
});

test('companion confirmation by a guest still requires host admission; canceled requests cannot be admitted', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), second = await client(lobby), room = crypto.randomUUID();
    await host.send('create', room, { title: 'Work', name: 'Alex', label: 'Desktop' });
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await second.send('request', room, { name: 'Companion', label: 'Tablet', kind: 'companion' });
    const request = (await second.status(room)).request!;
    await guest.send('link', room, { code: request.code });
    expect((await second.status(room)).memberId).toBeUndefined();
    await host.send('decide', room, { requestId: request.id, admit: true });
    expect((await second.status(room)).memberId).toBe((await guest.status(room)).memberId);
    await expect(second.send('remove', room, { deviceId: (await host.status(room)).deviceId })).rejects.toThrow('cannot remove');
    await host.send('remove', room, { deviceId: (await second.status(room)).deviceId });
    await second.send('request', room, { name: 'New request', label: 'Tablet', kind: 'person' });
    const fresh = (await second.status(room)).request!;
    await expect(guest.send('cancel', room, { requestId: fresh.id })).rejects.toThrow('only cancel your own');
    await second.send('cancel', room, { requestId: fresh.id });
    await expect(host.send('decide', room, { requestId: fresh.id, admit: true })).rejects.toThrow('no longer waiting');
  } finally { lobby.close(); }
});

test('signaling is scoped to admitted devices, current sessions and the coordinator epoch', async () => {
  const lobby = new BrowserLobby(':memory:', { origin });
  try {
    const host = await client(lobby), guest = await client(lobby), room = crypto.randomUUID(), other = crypto.randomUUID();
    await host.send('create', room, { title: 'A', name: 'Alex', label: 'Desktop' });
    await guest.send('create', other, { title: 'B', name: 'Sam', label: 'Laptop' });
    const target = await guest.status(other);
    const h = await host.status(room);
    const payload = { to: target.deviceId, session: host.session, targetSession: guest.session, description: { type: 'offer', sdp: 'test offer' } };
    await expect(host.send('signal', room, payload)).rejects.toThrow('not admitted');
    await guest.send('request', room, { name: 'Sam', label: 'Laptop', kind: 'person' });
    await host.send('decide', room, { requestId: (await host.status(room)).requests![0].id, admit: true });
    await guest.status(room);
    await host.send('signal', room, payload);
    const received = await guest.status(room);
    expect(received.signals).toHaveLength(1);
    expect(received.signals![0].from).toBe(h.deviceId);
    const drained = await guest.send('status', room, { session: guest.session, cursor: received.signals![0].seq, epoch: received.epoch }) as RoomStatus;
    expect(drained.signals).toHaveLength(0);
    const restarted = await guest.send('status', room, { session: guest.session, cursor: 999, epoch: 'previous-process' }) as RoomStatus;
    expect(restarted.signals).toHaveLength(1);
    await host.send('remove', room, { deviceId: target.deviceId });
    await expect(guest.send('signal', room, { ...payload, to: h.deviceId, session: guest.session, targetSession: host.session })).rejects.toThrow('admission');
  } finally { lobby.close(); }
});
