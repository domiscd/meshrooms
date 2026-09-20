import { createHash } from 'node:crypto';
import { LocalNode } from './node';
import { isHash, isUuid, type StoredMessage } from './model';
import type { IncomingPacket, PeerTransport } from './meshguard';

const CHUNK_BYTES = 512, MAX_CHUNKS = 128, MAX_ASSEMBLIES = 16;
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
type Assembly = { room: string; id: string; hash: string; count: number; chunks: Map<number, Buffer>; expires: number };
function canonical(message: StoredMessage): StoredMessage {
  return { id: message.id, authorId: message.authorId, author: message.author, role: message.role, text: message.text,
    time: message.time, share: message.share, replyTo: message.replyTo, requestId: message.requestId, fingerprint: message.fingerprint };
}
export function packets(room: string, message: StoredMessage): string[] {
  const data = Buffer.from(JSON.stringify(message)), hash = digest(data), n = Math.ceil(data.length / CHUNK_BYTES);
  if (n > MAX_CHUNKS) throw new Error('Room message exceeds the transport size limit.');
  return Array.from({ length: n }, (_, i) => JSON.stringify({ v: 1, k: 'chunk', room, id: message.id, hash, i, n,
    data: data.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).toString('base64') }));
}

/** History is the durable outbox; only a persisted receiver acknowledgment retires an item. */
export class PeerBridge {
  private assemblies = new Map<string, Assembly>();
  private retryAt = new Map<string, number>();
  private chunkOffset = new Map<string, number>();
  private roomOffset = 0;
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private closed = false;
  private connected = false;
  private lastError?: string;
  constructor(private node: LocalNode, private transport: PeerTransport) {}
  start() { this.timer = setInterval(() => { void this.pump(); }, 250); this.timer.unref(); void this.pump(); }
  close() { this.closed = true; clearInterval(this.timer); this.assemblies.clear(); }
  status() { return { connected: this.connected, error: this.lastError, rooms: this.node.pendingDelivery().map(r => ({
    roomId: r.roomId, peerKey: r.peerKey, pending: r.messages.map(m => m.id), storedRemotely: r.acknowledged,
  })) }; }
  async pump(now = Date.now()) {
    if (this.busy || this.closed) return;
    this.busy = true;
    try {
      await this.transport.check(); if (this.closed) return;
      this.connected = true; this.lastError = undefined;
      for (const [key, value] of this.assemblies) if (value.expires < now) this.assemblies.delete(key);
      for (let i = 0; i < 32 && !this.closed; i++) {
        const incoming = await this.transport.receive(); if (!incoming || this.closed) break;
        try { await this.ingest(incoming, now); }
        catch { /* An invalid/unadmitted packet receives no receipt. Sender retry repairs packet loss. */ }
      }
      const rooms = this.node.pendingDelivery(); let budget = 16;
      const start = this.roomOffset;
      for (let i = 0; i < rooms.length && budget > 0; i++) {
        const room = rooms[(start + i) % rooms.length];
        if (this.closed) break;
        const message = room.messages[0]; if (!message) continue;
        const key = `${room.roomId}:${message.id}`;
        if ((this.retryAt.get(key) || 0) > now) continue;
        try {
          const frames = packets(room.roomId, message); let offset = this.chunkOffset.get(key) || 0;
          const end = Math.min(frames.length, offset + Math.min(16, budget));
          while (offset < end && !this.closed) { await this.transport.send(room.peerKey, frames[offset++]); budget--; }
          this.chunkOffset.set(key, offset === frames.length ? 0 : offset);
          if (offset === frames.length) this.retryAt.set(key, now + 3000);
        }
        catch (error) { this.lastError = error instanceof Error ? error.message : 'Peer send failed.'; }
      }
      this.roomOffset = rooms.length ? (start + 1) % rooms.length : 0;
    } catch (error) { this.connected = false; this.lastError = error instanceof Error ? error.message : 'MeshGuard attachment failed.'; }
    finally { this.busy = false; }
  }
  async ingest(incoming: IncomingPacket, now = Date.now()) {
    if (this.closed || Buffer.byteLength(incoming.data) > 1024) return;
    const p = JSON.parse(incoming.data);
    if (!p || p.v !== 1 || !isUuid(p.room) || !isUuid(p.id) || !isHash(p.hash) || !this.node.acceptsPeer(p.room, incoming.sender)) return;
    if (p.k === 'ack') { this.node.acknowledgePeer(p.room, incoming.sender, p.id, p.hash); this.retryAt.delete(`${p.room}:${p.id}`); this.chunkOffset.delete(`${p.room}:${p.id}`); return; }
    if (p.k !== 'chunk' || !Number.isInteger(p.n) || p.n < 1 || p.n > MAX_CHUNKS || !Number.isInteger(p.i) || p.i < 0 || p.i >= p.n
      || typeof p.data !== 'string' || p.data.length > 684 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(p.data)) return;
    const chunk = Buffer.from(p.data, 'base64');
    if (!chunk.length || chunk.length > CHUNK_BYTES || (p.i < p.n - 1 && chunk.length !== CHUNK_BYTES)) return;
    const key = `${incoming.sender}:${p.room}:${p.id}:${p.hash}`;
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= MAX_ASSEMBLIES) return;
      assembly = { room: p.room, id: p.id, hash: p.hash, count: p.n, chunks: new Map(), expires: now + 30000 }; this.assemblies.set(key, assembly);
    }
    if (assembly.count !== p.n) return;
    assembly.chunks.set(p.i, chunk);
    if (assembly.chunks.size !== p.n) return;
    this.assemblies.delete(key);
    const data = Buffer.concat(Array.from({ length: p.n }, (_, i) => assembly!.chunks.get(i)!));
    if (digest(data) !== p.hash) return;
    const message = JSON.parse(data.toString('utf8'));
    if (message?.id !== p.id) return;
    if (digest(Buffer.from(JSON.stringify(canonical(message)))) !== p.hash) return;
    const storedHash = this.node.receivePeer(p.room, incoming.sender, message);
    // Receipt uses normalized persisted fields; unknown wire fields cannot manufacture a receipt.
    if (storedHash !== p.hash) return;
    await this.transport.send(incoming.sender, JSON.stringify({ v: 1, k: 'ack', room: p.room, id: p.id, hash: p.hash }));
  }
}
