import { randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import type { Draft, NodeSnapshot, Participant } from '../src/room';
import type { SetupCommand, PendingRoom } from '../src/setup';
import type { DurableStore } from './persistence/store';
import { CATALOG, CATALOG_V1, MAX_ROOMS, MAX_MESSAGES, MAX_HISTORY_BYTES, fingerprint, historyKey, isHash, isUuid,
  migrateV1, migrateV2, recover, tokenHash, validCatalog, validHistory, type Catalog, type History, type Principal, type RoomRecord, type StoredMessage } from './model';
import { parseDescriptor, type RoomDescriptor } from './peer-model';
export type { Principal } from './model';

export class NodeError extends Error { constructor(public status: number, message: string) { super(message); } }
export function requestId(value: unknown): string {
  if (!isUuid(value)) throw new NodeError(400, 'A UUID requestId is required. Reuse it when retrying the same command.');
  return value.toLowerCase();
}
function text(value: unknown, name: string, max: number, required = true): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new NodeError(400, `Enter ${name} up to ${max} characters.`);
  return value.trim();
}

export class LocalNode {
  private catalog: Catalog;
  private histories = new Map<string, History>();
  private listeners = new Set<() => void>();
  private leases = new Map<string, number>();
  private connections = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  private storageFailure = false;
  private closed = false;

  constructor(private readonly store: DurableStore) {
    const raw = store.read(CATALOG);
    let writeCatalog = false;
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.version === 2) { this.catalog = migrateV2(parsed); writeCatalog = true; }
        else this.catalog = recover<Catalog>(raw, 'node catalog', validCatalog);
      } catch { throw new Error('Cannot recover node catalog: invalid stored data. The store has not been reset.'); }
    }
    else {
      const legacy = store.read(CATALOG_V1);
      if (legacy !== null) {
        try { this.catalog = migrateV1(JSON.parse(legacy), hostname().slice(0, 64) || 'This machine'); }
        catch { throw new Error('Cannot recover node catalog: invalid stored data. The store has not been reset.'); }
      } else {
        const owner: Participant = { id: randomUUID(), name: 'You', role: 'human', state: 'local', detail: 'Local participant · room member' };
        this.catalog = { version: 3, nodeId: randomUUID(), ownerId: owner.id, participants: [owner], rooms: [],
          settings: { completed: false, machineName: hostname().slice(0, 64) || 'This machine', startAtLogin: false }, intents: [], setupReceipts: [] };
      }
      writeCatalog = true;
    }
    // Validate every old history before publishing the migrated catalog. Legacy records stay intact.
    for (const room of this.catalog.rooms) {
      const history = store.read(historyKey(room.id));
      if (history === null || Buffer.byteLength(history) > MAX_HISTORY_BYTES) throw new Error(`Cannot recover room ${room.id}: history is missing or too large. The store has not been reset.`);
      this.histories.set(room.id, recover<History>(history, `room ${room.id}`, value => validHistory(value, room, this.catalog.participants)));
      if (room.peer) {
        const messages = this.histories.get(room.id)!.messages;
        if ([...room.peer.excluded, ...room.peer.acknowledged].some(id => !messages.some(m => m.id === id))
          || room.peer.acknowledged.some(id => room.peer!.excluded.includes(id) || this.person(messages.find(m => m.id === id)!.authorId).state !== 'local')) {
          throw new Error('Cannot recover delivery receipts: invalid stored data. The store has not been reset.');
        }
      }
    }
    if (writeCatalog) store.write(CATALOG, JSON.stringify(this.catalog));
    this.timer = setInterval(() => {
      let changed = false;
      for (const [id, until] of this.leases) if (until <= Date.now()) { this.leases.delete(id); changed = true; }
      if (changed) this.notify();
    }, 5000);
    this.timer.unref();
  }

  get ready() { return !this.storageFailure && !this.closed; }
  get owner(): Principal { return { kind: 'owner', participantId: this.catalog.ownerId }; }
  get settings() { return { ...this.catalog.settings, humanName: this.person(this.catalog.ownerId).name }; }
  get nodeId() { return this.catalog.nodeId; }
  snapshot(principal: Principal = this.owner): NodeSnapshot {
    const rooms = this.catalog.rooms.filter(room => this.permitted(principal, room));
    return { backend: 'local', storage: 'wormdb', nodeId: this.catalog.nodeId, localParticipantId: principal.participantId,
      rooms: rooms.map(({ id, title, project, sample, participantIds, peer }) => ({ id, title, project, sample, ...(peer ? { paired: true } : {}),
        participants: participantIds.map(id => {
          const person = this.person(id);
          if (person.state === 'remote' || person.role !== 'agent') return { ...person };
          const connected = (this.connections.get(id) || 0) > 0 || (this.leases.get(id) || 0) > Date.now();
          return { ...person, connected, detail: connected ? 'Agent connected on this machine' : 'Awaiting agent connection' };
        }),
        messages: this.histories.get(id)!.messages.map(({ requestId: _, fingerprint: __, ...message }) => structuredClone(message)),
      })), availableRooms: [] };
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  close() { if (!this.closed) { this.closed = true; clearInterval(this.timer); this.listeners.clear(); this.store.close(); } }
  authenticateAgent(token: string): Principal | undefined {
    if (token.length < 32 || token.length > 256) return;
    const hash = Buffer.from(tokenHash(token), 'hex');
    const intent = this.catalog.intents.find(i => i.status === 'completed' && timingSafeEqual(hash, Buffer.from(i.tokenHash, 'hex')));
    return intent ? { kind: 'agent', participantId: intent.agentId, roomId: intent.roomId! } : undefined;
  }
  touch(principal: Principal) { if (principal.kind === 'agent') { const was = (this.leases.get(principal.participantId) || 0) > Date.now(); this.leases.set(principal.participantId, Date.now() + 45000); if (!was) this.notify(); } }
  connect(principal: Principal): () => void {
    if (principal.kind === 'owner') return () => {};
    const id = principal.participantId; this.connections.set(id, (this.connections.get(id) || 0) + 1); this.notify();
    let closed = false;
    return () => { if (!closed) { closed = true; this.connections.set(id, Math.max(0, (this.connections.get(id) || 0) - 1)); this.notify(); } };
  }
  pending(id: unknown): PendingRoom | undefined {
    if (id === undefined || id === '') return;
    const value = this.catalog.intents.find(intent => intent.id === id);
    if (!value) throw new NodeError(404, 'This room request is not on this machine. Run the Meshrooms skill again.');
    const { agentId: _, tokenHash: __, fingerprint: ___, ...visible } = value; return visible;
  }
  prepareRoom(input: { requestId?: unknown; title?: unknown; project?: unknown; agentName?: unknown; credentialHash?: unknown }): PendingRoom {
    this.assertReady();
    const id = requestId(input.requestId); const title = text(input.title, 'a room name', 64);
    const project = text(input.project ?? '', 'a project label', 48, false); const agentName = text(input.agentName, 'an agent name', 64);
    if (!isHash(input.credentialHash)) throw new NodeError(400, 'A credential hash is required.');
    const hash = fingerprint({ title, project, agentName, credentialHash: input.credentialHash });
    const existing = this.catalog.intents.find(intent => intent.id === id);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return this.pending(id)!; }
    if (this.catalog.rooms.some(room => room.id === id) || this.catalog.intents.some(i => i.tokenHash === input.credentialHash)) throw new NodeError(409, 'This request or credential already belongs to another room.');
    if (this.catalog.rooms.length + this.catalog.intents.filter(i => i.status === 'pending').length >= MAX_ROOMS) throw new NodeError(409, 'This local beta has reached its room limit.');
    this.saveCatalog({ ...this.catalog, intents: [...this.catalog.intents, { id, title, project, agentName, agentId: randomUUID(),
      tokenHash: input.credentialHash, fingerprint: hash, status: 'pending' }] });
    return this.pending(id)!;
  }
  validateSetup(input: Record<string, unknown>): SetupCommand {
    const command: SetupCommand = { requestId: requestId(input.requestId), humanName: text(input.humanName, 'your name', 64),
      machineName: text(input.machineName, 'a machine name', 64), startAtLogin: false };
    if (typeof input.startAtLogin !== 'boolean') throw new NodeError(400, 'Choose a startup preference.');
    command.startAtLogin = input.startAtLogin;
    if (input.intentId !== undefined) { command.intentId = requestId(input.intentId); this.pending(command.intentId); }
    const receipt = this.catalog.setupReceipts.find(r => r.id === command.requestId);
    if (receipt) this.assertRetry(receipt.fingerprint, fingerprint(command));
    else if (this.catalog.setupReceipts.length >= 256) throw new NodeError(409, 'This local beta has reached its settings update limit.');
    else if (command.humanName !== this.person(this.catalog.ownerId).name && this.catalog.rooms.some(room => room.peer)) {
      throw new NodeError(409, 'Paired rooms use a fixed participant grant. Keep your current name until updating peer grants is supported.');
    }
    return command;
  }
  setupResult(command: SetupCommand): { roomId?: string } | undefined {
    const receipt = this.catalog.setupReceipts.find(r => r.id === command.requestId);
    if (!receipt) return; this.assertRetry(receipt.fingerprint, fingerprint(command)); return receipt.roomId ? { roomId: receipt.roomId } : {};
  }
  completeSetup(input: Record<string, unknown>): { roomId?: string } {
    this.assertReady(); const command = this.validateSetup(input); const receipt = this.setupResult(command); if (receipt) return receipt;
    const next = structuredClone(this.catalog);
    next.settings = { completed: true, machineName: command.machineName, startAtLogin: command.startAtLogin };
    next.participants.find(p => p.id === next.ownerId)!.name = command.humanName;
    const intent = next.intents.find(i => i.id === command.intentId);
    let history: History | undefined;
    if (intent?.status === 'pending') {
      const agent: Participant = { id: intent.agentId, name: intent.agentName, role: 'agent', state: 'local', detail: 'Awaiting agent connection' };
      next.participants.push(agent);
      next.rooms.push({ id: intent.id, title: intent.title, project: intent.project, sample: false, participantIds: [next.ownerId, agent.id],
        requestId: intent.id, fingerprint: fingerprint({ title: intent.title, project: intent.project }) });
      history = { version: 2, roomId: intent.id, messages: [] };
      this.persist(historyKey(intent.id), history);
      intent.status = 'completed'; intent.roomId = intent.id;
    }
    next.setupReceipts.push({ id: command.requestId, fingerprint: fingerprint(command), roomId: intent?.roomId });
    this.persist(CATALOG, next); this.catalog = next;
    if (history) this.histories.set(history.roomId, history);
    this.notify(); return intent?.roomId ? { roomId: intent.roomId } : {};
  }
  createRoom(input: { title?: unknown; project?: unknown; requestId?: unknown }, principal: Principal = this.owner): { roomId: string } {
    this.assertReady(); this.requireOwner(principal);
    const id = requestId(input.requestId); const title = text(input.title, 'a room name', 64); const project = text(input.project ?? '', 'a project label', 48, false);
    const hash = fingerprint({ title, project }); const existing = this.catalog.rooms.find(room => room.requestId === id);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return { roomId: existing.id }; }
    if (this.catalog.intents.some(i => i.id === id)) throw new NodeError(409, 'This request is waiting for setup confirmation.');
    if (this.catalog.rooms.length + this.catalog.intents.filter(i => i.status === 'pending').length >= MAX_ROOMS) throw new NodeError(409, `This local beta supports ${MAX_ROOMS} rooms.`);
    const room: RoomRecord = { id, title, project, sample: false, participantIds: [this.catalog.ownerId], requestId: id, fingerprint: hash };
    const history: History = { version: 2, roomId: room.id, messages: [] };
    this.persist(historyKey(room.id), history); this.persist(CATALOG, { ...this.catalog, rooms: [...this.catalog.rooms, room] });
    this.catalog.rooms.push(room); this.histories.set(room.id, history); this.notify(); return { roomId: room.id };
  }
  joinRoom(input: { roomId?: unknown; requestId?: unknown }, principal: Principal = this.owner) {
    this.assertReady(); this.requireOwner(principal); requestId(input.requestId); return { roomId: this.requireRoom(input.roomId, principal).id };
  }
  send(input: { roomId?: unknown; requestId?: unknown; text?: unknown; replyTo?: unknown; share?: unknown }, principal: Principal = this.owner): { messageId: string; status: 'stored-locally' } {
    this.assertReady(); const room = this.requireRoom(input.roomId, principal); const id = requestId(input.requestId);
    const body = text(input.text ?? '', 'a message', 4000, false); let share: Draft['share'];
    if (input.share !== undefined) {
      const value = input.share as Record<string, unknown>; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NodeError(400, 'Use a labeled text excerpt.');
      const title = text(value.title, 'a source label', 100); text(value.text, 'an excerpt', 8000); share = { title, text: value.text as string };
    }
    if (!body && !share) throw new NodeError(400, 'Enter a message or a labeled excerpt.');
    const history = this.histories.get(room.id)!;
    if (input.replyTo !== undefined && (typeof input.replyTo !== 'string' || !history.messages.some(message => message.id === input.replyTo))) throw new NodeError(400, 'The reply target is not in this room. Choose a message from this room.');
    if (typeof input.replyTo === 'string' && room.peer?.excluded.includes(input.replyTo)) throw new NodeError(400, 'That message predates pairing and is private to this node. Send a new message instead.');
    const replyTo = input.replyTo as string | undefined; const hash = fingerprint({ text: body, share, replyTo });
    const existing = history.messages.find(m => m.requestId === id && m.authorId === principal.participantId);
    if (existing) { this.assertRetry(existing.fingerprint, hash); return { messageId: existing.id, status: 'stored-locally' }; }
    if (history.messages.length >= MAX_MESSAGES) throw new NodeError(409, `This local beta supports ${MAX_MESSAGES} messages per room.`);
    const actor = this.person(principal.participantId);
    const message: StoredMessage = { id: randomUUID(), authorId: actor.id, author: actor.name, role: actor.role, text: body,
      time: new Date().toISOString(), share, replyTo, requestId: id, fingerprint: hash };
    const next: History = { ...history, version: 2, messages: [...history.messages, message] };
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_HISTORY_BYTES) throw new NodeError(409, 'This room reached the local beta history size limit.');
    this.persist(historyKey(room.id), next); this.histories.set(room.id, next); this.touch(principal); this.notify(); return { messageId: message.id, status: 'stored-locally' };
  }
  requireOwner(principal: Principal) { if (principal.kind !== 'owner' || principal.participantId !== this.catalog.ownerId) throw new NodeError(403, 'This action requires the local human session.'); }
  descriptor(roomId: unknown, peerKey: string): RoomDescriptor {
    const room = this.requireRoom(roomId, this.owner);
    return { version: 1, roomId: room.id, peerKey, participants: room.participantIds.map(id => this.person(id))
      .filter(p => p.state === 'local').map(({ id, name, role }) => ({ id, name, role })) };
  }
  pairRoom(input: unknown, localKey: string) {
    this.assertReady();
    let descriptor: RoomDescriptor;
    try { descriptor = parseDescriptor(input); } catch { throw new NodeError(400, 'Invalid room pairing descriptor.'); }
    const room = this.requireRoom(descriptor.roomId, this.owner);
    if (descriptor.peerKey === localKey) throw new NodeError(400, 'Select another machine identity.');
    if (room.peer) {
      const prior = { version: 1, roomId: room.id, peerKey: room.peer.key, participants: room.peer.participantIds.map(id => {
        const { id: participantId, name, role } = this.person(id); return { id: participantId, name, role };
      }) };
      if (fingerprint(prior) !== fingerprint(descriptor)) throw new NodeError(409, 'This room is already paired. Changing membership requires a separate admission flow.');
      return { roomId: room.id };
    }
    const next = structuredClone(this.catalog), target = next.rooms.find(r => r.id === room.id)!;
    for (const person of descriptor.participants) {
      const prior = next.participants.find(p => p.id === person.id);
      if (prior && (prior.state !== 'remote' || prior.peerKey !== descriptor.peerKey || prior.name !== person.name || prior.role !== person.role)) throw new NodeError(409, 'A participant identity conflicts with this node.');
      if (!prior) next.participants.push({ ...person, state: 'remote', peerKey: descriptor.peerKey, detail: 'Remote room member · presence not tracked' });
    }
    target.peer = { key: descriptor.peerKey, participantIds: descriptor.participants.map(p => p.id),
      excluded: this.histories.get(room.id)!.messages.map(m => m.id), acknowledged: [] };
    target.participantIds.push(...target.peer.participantIds);
    if (!validCatalog(next)) throw new NodeError(409, 'The pairing conflicts with existing room identities.');
    this.saveCatalog(next); return { roomId: room.id };
  }
  acceptsPeer(roomId: string, key: string) { return this.catalog.rooms.some(r => r.id === roomId && r.peer?.key === key); }
  pendingDelivery() {
    return this.catalog.rooms.filter(r => r.peer).map(room => ({ roomId: room.id, peerKey: room.peer!.key,
      messages: structuredClone(this.histories.get(room.id)!.messages.filter(m => this.person(m.authorId).state === 'local'
        && !room.peer!.excluded.includes(m.id) && !room.peer!.acknowledged.includes(m.id))), acknowledged: [...room.peer!.acknowledged] }));
  }
  acknowledgePeer(roomId: string, key: string, messageId: string, hash: string) {
    this.assertReady();
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    const message = room && this.histories.get(roomId)!.messages.find(m => m.id === messageId && this.person(m.authorId).state === 'local');
    if (!room?.peer || !message || fingerprint(message) !== hash || room.peer.excluded.includes(messageId)) throw new NodeError(403, 'Unknown delivery receipt.');
    if (room.peer.acknowledged.includes(messageId)) return;
    const next = structuredClone(this.catalog); next.rooms.find(r => r.id === roomId)!.peer!.acknowledged.push(messageId); this.saveCatalog(next);
  }
  receivePeer(roomId: string, key: string, input: any) {
    this.assertReady();
    const room = this.catalog.rooms.find(r => r.id === roomId && r.peer?.key === key);
    if (!room?.peer || !room.peer.participantIds.includes(input?.authorId)) throw new NodeError(403, 'Peer is not admitted as this room author.');
    const message: StoredMessage = { id: input.id, authorId: input.authorId, author: input.author, role: input.role,
      text: input.text, time: input.time, share: input.share, replyTo: input.replyTo, requestId: input.requestId, fingerprint: input.fingerprint };
    const history = this.histories.get(roomId)!;
    const existing = history.messages.find(m => m.id === message.id || (m.authorId === message.authorId && m.requestId === message.requestId));
    if (existing) { this.assertRetry(fingerprint(existing), fingerprint(message)); return fingerprint(existing); }
    if (message.replyTo && room.peer.excluded.includes(message.replyTo)) throw new NodeError(400, 'The remote reply target predates pairing.');
    const next: History = { ...history, version: 2, messages: [...history.messages, message] };
    if (message.author !== this.person(message.authorId).name || message.fingerprint !== fingerprint({ text: message.text, share: message.share, replyTo: message.replyTo })
      || !validHistory(next, room, this.catalog.participants) || Buffer.byteLength(JSON.stringify(next)) > MAX_HISTORY_BYTES) throw new NodeError(400, 'Invalid remote room message.');
    this.persist(historyKey(roomId), next); this.histories.set(roomId, next); this.notify(); return fingerprint(message);
  }
  private permitted(principal: Principal, room: RoomRecord) { return room.participantIds.includes(principal.participantId) && (principal.kind === 'owner' || principal.roomId === room.id); }
  private person(id: string) { const person = this.catalog.participants.find(p => p.id === id); if (!person) throw new NodeError(403, 'Unknown participant.'); return person; }
  private requireRoom(id: unknown, principal: Principal): RoomRecord {
    const room = this.catalog.rooms.find(room => room.id === id && this.permitted(principal, room));
    if (!room) throw new NodeError(404, 'That room is not available to this participant.'); return room;
  }
  private assertReady() { if (!this.ready) throw new NodeError(503, 'Local storage is unavailable. Restore the store and restart the daemon before retrying.'); }
  private assertRetry(prior: string, next: string) { if (prior !== next) throw new NodeError(409, 'This requestId was already used for different content.'); }
  private persist(key: string, value: unknown) {
    try { this.store.write(key, JSON.stringify(value)); }
    catch { this.storageFailure = true; throw new NodeError(503, 'The local write could not be confirmed. Keep its requestId and retry after the daemon recovers.'); }
  }
  private saveCatalog(next: Catalog) { this.persist(CATALOG, next); this.catalog = next; this.notify(); }
  private notify() { for (const listener of this.listeners) { try { listener(); } catch { /* View errors cannot roll back accepted writes. */ } } }
}
