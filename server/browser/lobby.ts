import { Database } from 'bun:sqlite';
import { createHash, createHmac } from 'node:crypto';
import { browserProtocol, deviceId, verify, type BrowserDevice, type BrowserMember, type JoinRequest, type RoomStatus, type Signal, type SignedCommand } from '../../src/browser/protocol';

type Room = { id: string; title: string; ownerId: string; members: BrowserMember[]; devices: BrowserDevice[]; requests: JoinRequest[] };
export class LobbyError extends Error { constructor(public status: number, message: string) { super(message); } }
function fail(status: number, message: string): never { throw new LobbyError(status, message); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9-]{36}$/.test(v);
function label(v: unknown, max = 80): string {
  if (typeof v !== 'string' || !v.trim() || v.trim().length > max || /[\u0000-\u001f]/.test(v)) return fail(400, 'Enter a valid name.');
  return v.trim();
}
export type LobbyOptions = { origin: string; now?: () => number; stunUrls?: string[]; turnUrls?: string[]; turnSecret?: string };

/** SQLite stores admission only. Signaling/presence expire in memory; no chat passes through this service. */
export class BrowserLobby {
  private db: Database;
  private now: () => number;
  private presence = new Map<string, { session: string; at: number }>();
  private signals = new Map<string, (Signal & { at: number })[]>();
  private sequence = 0;
  private epoch = crypto.randomUUID();
  constructor(path: string, private options: LobbyOptions) {
    this.now = options.now || Date.now;
    this.db = new Database(path, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (device TEXT, id TEXT, body TEXT, result TEXT, at INTEGER, PRIMARY KEY(device,id));');
  }
  close() { this.db.close(); }
  healthy() { this.db.query('SELECT 1').get(); return true; }
  private load(id: string): Room {
    const row = this.db.query('SELECT body FROM rooms WHERE id=?').get(id) as { body: string } | null;
    return row ? JSON.parse(row.body) : fail(404, 'This room is unavailable. Check the invitation.');
  }
  publicRoom(id: string) { const r = this.load(id); return { roomId: r.id, title: r.title }; }
  async execute(input: SignedCommand): Promise<RoomStatus | { roomId: string }> {
    const c = input?.command;
    if (!c || c.protocol !== browserProtocol || c.origin !== this.options.origin || !uuid(c.id) || !uuid(c.roomId) || !Number.isSafeInteger(c.at) || Math.abs(this.now() - c.at) > 60_000 || !c.payload || typeof c.payload !== 'object' || Array.isArray(c.payload)) fail(400, 'This request has expired or is invalid. Try again.');
    if (typeof input.publicKey !== 'string' || typeof input.signature !== 'string' || !await verify(input.publicKey, c, input.signature)) fail(401, 'This device could not be authenticated.');
    const id = await deviceId(input.publicKey);
    // After verification, all read/modify/write work is synchronous in one transaction.
    return this.db.transaction(() => {
      if (c.action === 'status') return this.snapshot(this.load(c.roomId), id, c.payload);
      // Deduplication needs a fingerprint, not a retained copy of SDP or device codes.
      const serialized = createHash('sha256').update(JSON.stringify({ ...c, at: 0 })).digest('hex');
      const previous = this.db.query('SELECT body,result FROM receipts WHERE device=? AND id=?').get(id, c.id) as { body: string; result: string } | null;
      if (previous) {
        if (previous.body !== serialized) fail(409, 'That request ID was already used.');
        return JSON.parse(previous.result);
      }
      if (c.action === 'create') {
        const count = (this.db.query('SELECT COUNT(*) AS n FROM rooms').get() as { n: number }).n;
        if (count >= 64) fail(429, 'Room capacity reached.');
        const owned = this.db.query('SELECT body FROM rooms').all() as { body: string }[];
        if (owned.filter(row => { const r: Room = JSON.parse(row.body); return r.devices.some(d => d.id === id && d.memberId === r.ownerId); }).length >= 8) fail(429, 'This device already hosts eight rooms.');
        const existing = this.db.query('SELECT id FROM rooms WHERE id=?').get(c.roomId);
        if (existing) fail(409, 'This room already exists.');
        const memberId = crypto.randomUUID();
        const room: Room = { id: c.roomId, title: label(c.payload.title), ownerId: memberId,
          members: [{ id: memberId, name: label(c.payload.name) }],
          devices: [{ id, publicKey: input.publicKey, label: label(c.payload.label), memberId, admittedAt: this.now() }], requests: [] };
        this.save(room);
      } else {
        const room = this.load(c.roomId);
        const actor = room.devices.find(d => d.id === id);
        const isHost = actor?.memberId === room.ownerId;
        const pending = (requestId: unknown) => room.requests.find(r => r.id === requestId && r.state === 'pending' && r.expiresAt > this.now()) || fail(409, 'This request is no longer waiting.');
        const admit = (r: JoinRequest) => {
          if (room.devices.length >= 16) fail(429, 'This room has reached its device limit.');
          if (r.kind === 'companion' && !r.linkedMemberId) fail(409, 'Confirm this device from its existing identity first.');
          const memberId = r.linkedMemberId || crypto.randomUUID();
          if (!r.linkedMemberId) room.members.push({ id: memberId, name: r.name });
          room.devices.push({ ...r.device, memberId, admittedAt: this.now() });
          r.state = 'admitted'; delete r.code;
        };
        switch (c.action) {
          case 'request': {
            if (actor) break;
            const current = room.requests.find(r => r.device.id === id && r.state === 'pending' && r.expiresAt > this.now());
            if (current) break;
            room.requests = room.requests.filter(r => r.device.id !== id && r.state === 'pending' && r.expiresAt > this.now());
            if (room.requests.length >= 16) fail(429, 'The waiting room is full. Please try again later.');
            if (!['person', 'companion'].includes(String(c.payload.kind))) fail(400, 'Choose how to join.');
            const kind = c.payload.kind as JoinRequest['kind'];
            room.requests.push({ id: c.id, name: label(c.payload.name), kind, state: 'pending', expiresAt: this.now() + 600_000,
              device: { id, publicKey: input.publicKey, label: label(c.payload.label), memberId: '', admittedAt: 0 },
              ...(kind === 'companion' ? { code: crypto.randomUUID().replaceAll('-', '').slice(0, 16) } : {}) });
            break;
          }
          case 'link': {
            if (!actor) fail(403, 'Join this room from your existing device first.');
            const r = room.requests.find(r => r.kind === 'companion' && r.code === c.payload.code && r.state === 'pending' && r.expiresAt > this.now()) || fail(404, 'Device code not found or expired.');
            if (r.linkedMemberId && r.linkedMemberId !== actor.memberId) fail(409, 'That device is already linked.');
            r.linkedMemberId = actor.memberId;
            if (isHost) admit(r);
            break;
          }
          case 'cancel': {
            const r = pending(c.payload.requestId);
            if (r.device.id !== id) fail(403, 'You can only cancel your own request.');
            room.requests = room.requests.filter(request => request.id !== r.id);
            break;
          }
          case 'decide': {
            if (!isHost) fail(403, 'Only the host can admit or decline requests.');
            const r = pending(c.payload.requestId);
            if (c.payload.admit === true) admit(r);
            else if (c.payload.admit === false) { r.state = 'declined'; delete r.code; }
            else fail(400, 'Choose admit or decline.');
            break;
          }
          case 'remove': {
            const target = room.devices.find(d => d.id === c.payload.deviceId) || fail(404, 'Device not found.');
            if (!actor || (!isHost && actor.memberId !== target.memberId)) fail(403, 'You cannot remove this device.');
            if (target.memberId === room.ownerId && room.devices.filter(d => d.memberId === room.ownerId).length === 1) fail(409, 'Keep at least one host device.');
            room.devices = room.devices.filter(d => d.id !== target.id);
            room.members = room.members.filter(m => room.devices.some(d => d.memberId === m.id));
            room.requests = room.requests.filter(r => r.device.id !== target.id);
            this.presence.delete(`${room.id}:${target.id}`); this.signals.delete(`${room.id}:${target.id}`);
            break;
          }
          case 'signal': {
            if (!actor) fail(403, 'Room admission is required.');
            const target = room.devices.find(d => d.id === c.payload.to) || fail(403, 'The recipient is not admitted.');
            const local = this.presence.get(`${room.id}:${id}`), remote = this.presence.get(`${room.id}:${target.id}`);
            if (!local || local.session !== c.payload.session || !remote || remote.session !== c.payload.targetSession || remote.at < this.now() - 10_000) fail(409, 'The connection changed. Reconnecting.');
            const description = c.payload.description as RTCSessionDescriptionInit;
            if (!description || !['offer', 'answer'].includes(description.type) || typeof description.sdp !== 'string' || description.sdp.length > 16_000) fail(400, 'Invalid connection offer.');
            const key = `${room.id}:${target.id}`;
            const queue = (this.signals.get(key) || []).filter(s => s.at > this.now() - 30_000);
            if (queue.length >= 32) fail(429, 'Connection busy. Try again.');
            queue.push({ seq: ++this.sequence, from: id, session: local.session, targetSession: remote.session, description, at: this.now() });
            this.signals.set(key, queue);
            break;
          }
          default: fail(400, 'Unknown room action.');
        }
        if (c.action !== 'signal') this.save(room);
      }
      const result = { roomId: c.roomId };
      this.db.query('DELETE FROM receipts WHERE at < ?').run(this.now() - 120_000);
      this.db.query('INSERT INTO receipts VALUES (?,?,?,?,?)').run(id, c.id, serialized, JSON.stringify(result), this.now());
      return result;
    })();
  }
  private save(room: Room) { this.db.query('INSERT OR REPLACE INTO rooms VALUES (?,?)').run(room.id, JSON.stringify(room)); }
  private snapshot(room: Room, id: string, payload: Record<string, unknown>): RoomStatus {
    for (const [key, value] of this.presence) if (value.at < this.now() - 30_000) this.presence.delete(key);
    for (const [key, value] of this.signals) {
      const active = value.filter(s => s.at > this.now() - 30_000);
      if (active.length) this.signals.set(key, active); else this.signals.delete(key);
    }
    const online = (d: BrowserDevice) => {
      const p = this.presence.get(`${room.id}:${d.id}`);
      return p && p.at > this.now() - 10_000 ? p.session : undefined;
    };
    const result: RoomStatus = { roomId: room.id, title: room.title, epoch: this.epoch, deviceId: id, hostOnline: room.devices.some(d => d.memberId === room.ownerId && !!online(d)) };
    const actor = room.devices.find(d => d.id === id);
    if (!actor) {
      const request = room.requests.find(r => r.device.id === id);
      result.request = request?.state === 'pending' && request.expiresAt <= this.now() ? { ...request, state: 'expired', code: undefined } : request;
      return result;
    }
    if (!uuid(payload.session)) fail(400, 'Invalid browser session.');
    this.presence.set(`${room.id}:${id}`, { session: payload.session, at: this.now() });
    result.memberId = actor.memberId; result.ownerId = room.ownerId;
    result.members = room.members.filter(m => room.devices.some(d => d.memberId === m.id));
    result.devices = room.devices.map(d => ({ ...d, session: online(d) }));
    if (actor.memberId === room.ownerId) result.requests = room.requests.filter(r => r.state === 'pending' && r.expiresAt > this.now()).map(r => { const { code, ...rest } = r; return rest; });
    const key = `${room.id}:${id}`;
    const cursor = payload.epoch === this.epoch && typeof payload.cursor === 'number' && Number.isSafeInteger(payload.cursor) ? payload.cursor : 0;
    result.signals = (this.signals.get(key) || []).filter(s => s.targetSession === payload.session && s.seq > cursor && room.devices.some(d => d.id === s.from));
    result.iceServers = this.iceServers(id);
    return result;
  }
  private iceServers(id: string): RTCIceServer[] {
    const servers: RTCIceServer[] = [];
    if (this.options.stunUrls?.length) servers.push({ urls: this.options.stunUrls });
    if (this.options.turnUrls?.length && this.options.turnSecret) {
      const username = `${Math.floor(this.now() / 1000) + 3600}:${id}`;
      servers.push({ urls: this.options.turnUrls, username, credential: createHmac('sha1', this.options.turnSecret).update(username).digest('base64') });
    }
    return servers;
  }
}
