import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { LocalNode } from './node';
import { PeerBridge, packets } from './peer-bridge';
import { CATALOG, fingerprint, tokenHash } from './model';
import type { IncomingPacket, PeerTransport } from './meshguard';

const nodes: LocalNode[] = [], bridges: PeerBridge[] = [];
afterEach(() => { for (const b of bridges.splice(0)) b.close(); for (const n of nodes.splice(0)) n.close(); });
function database() {
  const data = new Map<string, string>(); let fail = false;
  return { data, failWrites() { fail = true; }, recoverWrites() { fail = false; }, store: () => ({
    read: (key: string) => data.get(key) ?? null, write: (key: string, value: string) => { if (fail) throw new Error('disk failed'); data.set(key, value); }, close() {},
  }) };
}
function node(db = database()) { const n = new LocalNode(db.store()); nodes.push(n); return n; }
function fixture() {
  const dbA = database(), dbB = database(), a = node(dbA), b = node(dbB), room = randomUUID();
  const keyA = 'a'.repeat(64), keyB = 'b'.repeat(64);
  for (const [n, name] of [[a, 'Codex'], [b, 'Grok']] as const) {
    n.prepareRoom({ requestId: room, title: 'Transport test', agentName: name, credentialHash: tokenHash(name.repeat(16)) });
    n.completeSetup({ requestId: randomUUID(), intentId: room, humanName: `Test ${name} owner`, machineName: 'Test node', startAtLogin: false });
  }
  const descriptorA = a.descriptor(room, keyA), descriptorB = b.descriptor(room, keyB);
  a.pairRoom(descriptorB, keyA); b.pairRoom(descriptorA, keyB);
  const inboxA: IncomingPacket[] = [], inboxB: IncomingPacket[] = [];
  const state = { dropAcks: false, available: true };
  const makeWire = (sender: string, own: IncomingPacket[], remote: IncomingPacket[]): PeerTransport => ({
    async check() { if (!state.available) throw new Error('offline'); },
    async receive() { return own.shift() ?? null; },
    async send(_peer, data) { if (!state.dropAcks || JSON.parse(data).k !== 'ack') remote.push({ sender, data }); },
  });
  const wireA = makeWire(keyA, inboxA, inboxB), wireB = makeWire(keyB, inboxB, inboxA);
  const bridgeA = new PeerBridge(a, wireA), bridgeB = new PeerBridge(b, wireB); bridges.push(bridgeA, bridgeB);
  return { a, b, dbA, dbB, room, keyA, keyB, wireA, wireB, bridgeA, bridgeB, inboxA, inboxB, state };
}

test('two admitted agents exchange fragmented unicode, while other rooms and author spoofing stay excluded', async () => {
  const f = fixture(), secretRoom = f.a.createRoom({ title: 'Private', requestId: randomUUID() }).roomId;
  f.a.send({ roomId: secretRoom, requestId: randomUUID(), text: 'Never shared' });
  const text = 'café 🚀'.repeat(300);
  const sent = f.a.send({ roomId: f.room, requestId: randomUUID(), text }, f.a.authenticateAgent('Codex'.repeat(16))!);
  await f.bridgeA.pump(1); expect(f.inboxB.length).toBeGreaterThan(1);
  f.inboxB.reverse();
  await f.bridgeB.pump(1); await f.bridgeA.pump(2);
  const roomB = f.b.snapshot().rooms[0]; expect(roomB.messages.map(m => [m.author, m.role, m.text])).toEqual([['Codex', 'agent', text]]);
  expect(f.b.snapshot().rooms).toHaveLength(1);
  expect(f.bridgeA.status().rooms[0].storedRemotely).toEqual([sent.messageId]);
  f.b.send({ roomId: f.room, requestId: randomUUID(), text: 'Received', replyTo: sent.messageId }, f.b.authenticateAgent('Grok'.repeat(16))!);
  await f.bridgeB.pump(2); await f.bridgeA.pump(3);
  expect(f.a.snapshot().rooms[0].messages.at(-1)?.author).toBe('Grok');
  const pending = f.b.pendingDelivery()[0].messages[0];
  expect(() => f.a.receivePeer(f.room, 'c'.repeat(64), pending)).toThrow('not admitted');
  expect(() => f.a.receivePeer(secretRoom, f.keyB, pending)).toThrow('not admitted');
  expect(() => f.a.receivePeer(f.room, f.keyB, { ...pending, authorId: f.a.owner.participantId })).toThrow('not admitted');
});

test('lost remote receipt plus sender and receiver restart retries without duplicate logical messages', async () => {
  const f = fixture(); f.state.dropAcks = true;
  const command = { roomId: f.room, requestId: randomUUID(), text: 'Durable retry' };
  const sent = f.a.send(command);
  await f.bridgeA.pump(1); await f.bridgeB.pump(1);
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(1); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1);
  f.bridgeA.close(); f.bridgeB.close(); f.a.close(); f.b.close();
  const a = node(f.dbA), b = node(f.dbB), ba = new PeerBridge(a, f.wireA), bb = new PeerBridge(b, f.wireB); bridges.push(ba, bb);
  f.state.dropAcks = false;
  expect(a.send(command).messageId).toBe(sent.messageId);
  await ba.pump(4000); await bb.pump(4000); await ba.pump(4001);
  expect(b.snapshot().rooms[0].messages).toHaveLength(1);
  expect(a.pendingDelivery()[0].messages).toHaveLength(0);
  expect(a.pendingDelivery()[0].acknowledged).toEqual([sent.messageId]);
  a.close(); const again = node(f.dbA); expect(again.pendingDelivery()[0].messages).toHaveLength(0);
});

test('a failed receiving store never produces a remote receipt; retry recovers after restart', async () => {
  const f = fixture(); f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'Must persist first' }); f.dbB.failWrites();
  await f.bridgeA.pump(1); await f.bridgeB.pump(1);
  expect(f.inboxA).toHaveLength(0); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1); expect(f.b.ready).toBe(false);
  f.bridgeB.close(); f.b.close(); f.dbB.recoverWrites();
  const b = node(f.dbB), bb = new PeerBridge(b, f.wireB); bridges.push(bb);
  await f.bridgeA.pump(4000); await bb.pump(4000); await f.bridgeA.pump(4001);
  expect(b.snapshot().rooms[0].messages).toHaveLength(1); expect(f.a.pendingDelivery()[0].messages).toHaveLength(0);
});

test('pairing does not publish old history and rejects conflicting grants and message retries', () => {
  const db = database(), a = node(db), b = node(), room = randomUUID();
  a.createRoom({ title: 'Room', requestId: room }); b.createRoom({ title: 'Room', requestId: room });
  const beforePairing = a.send({ roomId: room, requestId: randomUUID(), text: 'Before pairing' });
  const descriptor = b.descriptor(room, 'b'.repeat(64));
  a.pairRoom(descriptor, 'a'.repeat(64)); a.pairRoom(descriptor, 'a'.repeat(64));
  expect(a.pendingDelivery()[0].messages).toHaveLength(0);
  expect(() => a.pairRoom({ ...descriptor, peerKey: 'c'.repeat(64) }, 'a'.repeat(64))).toThrow('already paired');
  b.pairRoom(a.descriptor(room, 'a'.repeat(64)), 'b'.repeat(64)); b.send({ roomId: room, requestId: randomUUID(), text: 'Original' });
  const incoming = b.pendingDelivery()[0].messages[0]; a.receivePeer(room, 'b'.repeat(64), incoming);
  const privateReply = { ...incoming, id: randomUUID(), requestId: randomUUID(), replyTo: beforePairing.messageId,
    fingerprint: fingerprint({ text: incoming.text, share: incoming.share, replyTo: beforePairing.messageId }) };
  expect(() => a.receivePeer(room, 'b'.repeat(64), privateReply)).toThrow('predates pairing');
  const changed = { ...incoming, text: 'Changed', fingerprint: fingerprint({ text: 'Changed' }) };
  expect(() => a.receivePeer(room, 'b'.repeat(64), changed)).toThrow('different content');
  a.close(); expect(node(db).snapshot().rooms[0].messages.map(m => m.text)).toEqual(['Before pairing', 'Original']);
});

test('paired fixed grants reject owner renames before settings can strand delivery', () => {
  const f = fixture();
  const original = { requestId: randomUUID(), humanName: f.a.settings.humanName, machineName: 'Updated node', startAtLogin: false };
  f.a.completeSetup(original);
  expect(f.a.completeSetup(original)).toEqual({});
  expect(() => f.a.completeSetup({ ...original, requestId: randomUUID(), humanName: 'Renamed owner' })).toThrow('fixed participant grant');
  expect(f.a.settings.humanName).toBe('Test Codex owner');
});

test('offline attachment keeps messages pending and malformed frames cannot create authors or receipts', async () => {
  const f = fixture(); f.a.send({ roomId: f.room, requestId: randomUUID(), text: 'Queued' }); f.state.available = false;
  await f.bridgeA.pump(1); expect(f.bridgeA.status().connected).toBe(false); expect(f.a.pendingDelivery()[0].messages).toHaveLength(1);
  f.state.available = true;
  const message = f.a.pendingDelivery()[0].messages[0], packet = JSON.parse(packets(f.room, message)[0]);
  await f.bridgeB.ingest({ sender: 'c'.repeat(64), data: JSON.stringify(packet) });
  await f.bridgeB.ingest({ sender: f.keyA, data: JSON.stringify({ ...packet, n: 999999 }) });
  await f.bridgeB.ingest({ sender: f.keyA, data: JSON.stringify({ ...packet, hash: 'f'.repeat(64) }) });
  expect(f.b.snapshot().rooms[0].messages).toHaveLength(0); expect(f.inboxA).toHaveLength(0);
  await f.bridgeA.pump(4000); await f.bridgeB.pump(4000); expect(f.b.snapshot().rooms[0].messages).toHaveLength(1);
});

test('v2 catalog migration preserves node identity; invalid stored room grants fail closed', () => {
  const db = database(), before = node(db), identity = before.nodeId; before.close();
  const legacy = JSON.parse(db.data.get(CATALOG)!); legacy.version = 2; db.data.set(CATALOG, JSON.stringify(legacy));
  const migrated = node(db); expect(migrated.nodeId).toBe(identity); expect(JSON.parse(db.data.get(CATALOG)!).version).toBe(3); migrated.close();
  const bad = JSON.parse(db.data.get(CATALOG)!); bad.rooms.push({ id: randomUUID(), peer: { key: 'not a key' } }); db.data.set(CATALOG, JSON.stringify(bad));
  expect(() => node(db)).toThrow('not been reset'); expect(db.data.get(CATALOG)).toBe(JSON.stringify(bad));
});

test('maximum-size unicode text and excerpt are paced below the native queue bound', async () => {
  const f = fixture(), text = '漢'.repeat(4000), share = { title: 'Explicit excerpt', text: '漢'.repeat(8000) };
  f.a.send({ roomId: f.room, requestId: randomUUID(), text, share });
  expect(packets(f.room, f.a.pendingDelivery()[0].messages[0]).length).toBeGreaterThan(64);
  for (let now = 1; now < 6000 && f.a.pendingDelivery()[0].messages.length; now += 250) {
    await f.bridgeA.pump(now); expect(f.inboxB.length).toBeLessThanOrEqual(16); await f.bridgeB.pump(now);
  }
  expect(f.b.snapshot().rooms[0].messages[0].share).toEqual(share);
  expect(f.b.snapshot().rooms[0].messages[0].text).toBe(text);
  expect(f.a.pendingDelivery()[0].messages).toHaveLength(0);
});
