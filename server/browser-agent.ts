/**
 * Browser-room agent bridge (stage 1).
 *
 * Lets a local agent take part in a hosted browser room (meshrooms-browser-v1) as its
 * own device: a P-256 identity kept on this machine, WebRTC data channels via werift,
 * and signed packets exactly like a browser. `listen` and `send` apply the same
 * humans-first rules as local rooms (src/collab.ts), so agents behave identically.
 *
 * State lives in a private directory (identity, messages, task operations, outbox). `run`
 * is the only process that talks to peers; `listen` reads its state and `send`/`task`
 * queue outgoing messages and task changes that `run` signs and delivers.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { browserProtocol, type BrowserDevice, type Command, type RoomStatus } from '../src/browser/protocol';
import { foldBoard, MAX_TASK_OPS, syncChunks, taskBody, validTaskBody, type BoardSync, type TaskChange, type TaskPacket } from '../src/browser/board';
import { evaluateWake, mayAgentSpeak, mentionedIds, type Floor, type Task } from '../src/collab';
import type { Message, Participant } from '../src/room';

type Identity = { id: string; publicKey: string; privateJwk: JsonWebKey };
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string };
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody; signature: string };
type Stored = { packet: { body: MessageBody; signature: string }; targets: string[]; receipts: string[] };
type Members = { memberId?: string; members: { id: string; name: string; role?: 'human' | 'agent'; operatorId?: string }[]; devices: { id: string; memberId: string }[] };
/** A queued task change; `run` applies it to the board as it stands when signing, so the revision is current. */
type TaskIntent = { type: 'task'; id: string; taskId: string; change: TaskChange; removed?: boolean };
type Peer = { pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; started: number };

const b64 = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString('base64');
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function writeJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 }); renameSync(temporary, path);
}
function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }

export function parseRoomUrl(url: string) {
  const parsed = new URL(url);
  const match = /^\/r\/([a-f0-9-]{36})$/.exec(parsed.pathname);
  if (parsed.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(parsed.hostname)) throw new Error('Use the HTTPS room link.');
  if (!match) throw new Error('Use a browser room link like https://host/r/<room id>.');
  return { origin: parsed.origin, roomId: match[1] };
}

/** One agent's membership in one browser room. */
export class BrowserAgent {
  readonly dir: string;
  private identity?: Identity;
  private key?: CryptoKey;
  constructor(dataDir: string, readonly origin: string, readonly roomId: string) {
    this.dir = resolve(dataDir, 'browser-agents', roomId); mkdirSync(join(this.dir, 'outbox'), { recursive: true, mode: 0o700 });
  }
  private path(name: string) { return join(this.dir, name); }
  async ensureIdentity(): Promise<Identity> {
    if (this.identity) return this.identity;
    const file = this.path('identity.json');
    if (!existsSync(file)) {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const publicKey = b64(await crypto.subtle.exportKey('raw', keys.publicKey));
      const id = createHash('sha256').update(Buffer.from(publicKey, 'base64')).digest('hex');
      writeFileSync(file, JSON.stringify({ id, publicKey, privateJwk: await crypto.subtle.exportKey('jwk', keys.privateKey) }), { mode: 0o600, flag: 'wx' });
    }
    this.identity = JSON.parse(readFileSync(file, 'utf8'));
    this.key = await crypto.subtle.importKey('jwk', this.identity!.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return this.identity!;
  }
  async sign(value: unknown) {
    await this.ensureIdentity();
    return b64(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.key!, encode(value)));
  }
  async verify(publicKey: string, value: unknown, signature: string) {
    try {
      const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signature, 'base64'), encode(value));
    } catch { return false; }
  }
  /** A signed coordinator command. Retries of one logical action reuse its id. */
  async command(action: Command['action'] | 'agent-redeem', payload: Record<string, unknown> = {}, id: string = randomUUID()): Promise<any> {
    const identity = await this.ensureIdentity();
    // 'agent-redeem' joins the protocol with browser-room agents; older coordinators reject it with a clear error.
    const command = { protocol: browserProtocol, origin: this.origin, id, at: Date.now(), action, roomId: this.roomId, payload } as Command;
    const response = await fetch(`${this.origin}/api/lobby`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', Origin: this.origin },
      body: JSON.stringify({ command, publicKey: identity.publicKey, signature: await this.sign(command) }) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `Room service rejected ${action} (${response.status}).`);
    return result;
  }
  messages(): Stored[] { return readJson(this.path('messages.json'), []); }
  members(): Members { return readJson(this.path('members.json'), { members: [], devices: [] }); }
  settings(): { floor: Floor } { return readJson(this.path('settings.json'), { floor: 'humans-first' as Floor }); }
  /** Verified task operations in arrival order; the board cursor is a position in this list. */
  taskOps(): TaskPacket[] { return readJson(this.path('tasks.json'), []); }

  /** The room as local-room shapes, so collab.ts rules apply unchanged. */
  view() {
    const { memberId, members } = this.members();
    const participants: Participant[] = members.map(m => ({ id: m.id, name: m.name, role: m.id === memberId ? 'agent' : m.role ?? 'human',
      state: m.id === memberId ? 'local' : 'remote', detail: 'Browser room member', ...(m.operatorId ? { operatorId: m.operatorId } : {}) }));
    const messages: Message[] = this.messages().map(({ packet: { body } }) => {
      const author = participants.find(p => p.id === body.memberId);
      const mentions = mentionedIds(body.text, participants);
      return { id: body.id, authorId: body.memberId, author: author?.name ?? 'Former member', role: author?.role ?? 'human', text: body.text,
        time: new Date(body.at).toISOString(), ...(body.replyTo ? { replyTo: body.replyTo } : {}), ...(mentions.length ? { mentions } : {}) };
    });
    const ops = this.taskOps();
    return { memberId, participants, messages, floor: this.settings().floor, tasks: boardTasks(ops), boardRevision: ops.length };
  }
}

/**
 * The folded board, with assignedRevision rewritten as the board cursor at which this device received the assigning
 * operation. Task revisions count per task, but wake cursors must count across the room, like local rooms.
 */
export function boardTasks(ops: TaskPacket[]): Task[] {
  return foldBoard(ops.map(p => p.body)).map(task => {
    if (!task.assigneeId) return task;
    let position = 0;
    ops.forEach((p, index) => { const b = p.body;
      if (b.taskId === task.id && b.revision === task.assignedRevision && b.assigneeId === task.assigneeId && b.memberId === task.assignedBy) position = index + 1; });
    return { ...task, assignedRevision: position };
  });
}

/** Long-running peer loop: presence, signaling, data channels, storage, and outbox delivery. */
export async function runBridge(agent: BrowserAgent, log: (line: string) => void = console.error) {
  const identity = await agent.ensureIdentity();
  const session = randomUUID(); const peers = new Map<string, Peer>();
  let status: RoomStatus | undefined; let epoch = ''; let cursor = 0;
  let serial: Promise<unknown> = Promise.resolve();
  const transaction = <T>(work: () => Promise<T>) => { const next = serial.then(work); serial = next.catch(() => {}); return next; };
  const save = (messages: Stored[]) => writeJson(join(agent.dir, 'messages.json'), messages);
  const saveOps = (ops: TaskPacket[]) => writeJson(join(agent.dir, 'tasks.json'), ops);
  /** Keep a task operation signed by a current device of its author; duplicates and a full board are ignored. */
  const acceptOps = async (packets: unknown[]) => {
    const ops = agent.taskOps(); const known = new Set(ops.map(p => p.body.id)); const added: TaskPacket[] = [];
    for (const packet of packets as TaskPacket[]) {
      const b = packet?.body;
      if (ops.length + added.length >= MAX_TASK_OPS) break;
      if (!validTaskBody(b, agent.roomId) || known.has(b.id) || typeof packet.signature !== 'string') continue;
      // A change by someone who has since left still verifies against the key the room service keeps for them.
      const author = status?.devices?.find(d => d.id === b.deviceId) ?? status?.formerDevices?.find(d => d.id === b.deviceId);
      if (!author || author.memberId !== b.memberId || !await agent.verify(author.publicKey, b, packet.signature)) continue;
      known.add(b.id); added.push({ body: b, signature: packet.signature });
    }
    if (added.length) saveOps([...ops, ...added]);
  };

  const flush = () => {
    const messages = agent.messages();
    for (const [id, peer] of peers) {
      if (peer.channel?.readyState !== 'open') continue;
      for (const m of messages) if (m.packet.body.deviceId === identity.id && m.targets.includes(id) && !m.receipts.includes(id)) peer.channel.send(JSON.stringify(m.packet));
    }
  };
  const connectChannel = (peer: Peer, id: string, channel: RTCDataChannel) => {
    peer.channel = channel;
    channel.stateChanged.subscribe(state => {
      if (state !== 'open') return;
      log(`channel open to ${id.slice(0, 8)}`);
      // Exchange boards so either side catches up on tasks changed while apart.
      for (const chunk of syncChunks(agent.roomId, agent.taskOps())) channel.send(JSON.stringify(chunk));
      flush();
    });
    channel.onMessage.subscribe(raw => void transaction(async () => {
      const text = raw.toString(); if (text.length > 20_000 || peers.get(id) !== peer) return;
      const device = status?.devices?.find(d => d.id === id); if (!device) return;
      let packet: Packet; try { packet = JSON.parse(text); } catch { return; }
      const sync = packet as unknown as BoardSync;
      if (sync?.kind === 'board') { if (sync.roomId === agent.roomId && Array.isArray(sync.ops)) await acceptOps(sync.ops); return; }
      if ((packet?.body as { kind?: string })?.kind === 'task') { await acceptOps([packet]); return; }
      const b = packet?.body;
      if (!b || b.roomId !== agent.roomId || b.deviceId !== id || typeof b.id !== 'string' || !/^[a-f0-9-]{36}$/.test(b.id)
        || typeof packet.signature !== 'string' || !await agent.verify(device.publicKey, b, packet.signature)) return;
      if (b.kind === 'message') {
        if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at)) return;
        if (b.replyTo !== undefined && (typeof b.replyTo !== 'string' || !/^[a-f0-9-]{36}$/.test(b.replyTo))) return;
        const messages = agent.messages(); const existing = messages.find(m => m.packet.body.id === b.id);
        if (existing && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
        if (!existing) { if (messages.length >= 1000) return; save([...messages, { packet: packet as Stored['packet'], targets: [], receipts: [] }]); }
        const receipt: ReceiptBody = { kind: 'receipt', roomId: agent.roomId, id: b.id, deviceId: identity.id };
        if (channel.readyState === 'open') channel.send(JSON.stringify({ body: receipt, signature: await agent.sign(receipt) }));
      } else if (b.kind === 'receipt') {
        const messages = agent.messages(); const m = messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === identity.id);
        if (m?.targets.includes(id) && !m.receipts.includes(id)) save(messages.map(x => x === m ? { ...x, receipts: [...x.receipts, id] } : x));
      }
    }).catch(error => log(`incoming: ${error.message}`)));
  };
  const makePeer = (device: BrowserDevice & { session?: string }) => {
    // werift takes one URL per entry: expand each server so TURN udp/tcp/tls all stay available.
    const iceServers = (status?.iceServers || []).flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls])
      .map(urls => ({ urls, username: s.username, credential: s.credential as string | undefined })));
    const pc = new RTCPeerConnection({ iceServers });
    const peer: Peer = { pc, session: device.session!, started: Date.now() };
    peers.set(device.id, peer);
    pc.onDataChannel.subscribe(channel => connectChannel(peer, device.id, channel));
    return peer;
  };
  const describe = async (id: string, peer: Peer, offer: boolean) => {
    await peer.pc.setLocalDescription(offer ? await peer.pc.createOffer() : await peer.pc.createAnswer());
    await new Promise(r => setTimeout(r, 1500)); // werift gathers host/srflx candidates quickly; descriptions are not trickled.
    if (peers.get(id) !== peer) return;
    await agent.command('signal', { to: id, session, targetSession: peer.session, description: { type: peer.pc.localDescription!.type, sdp: peer.pc.localDescription!.sdp } });
  };
  const deliverOutbox = () => transaction(async () => {
    const outbox = join(agent.dir, 'outbox');
    for (const file of readdirSync(outbox).filter(f => f.endsWith('.json')).sort()) {
      const item = readJson<{ id: string; text: string; replyTo?: string } | TaskIntent | null>(join(outbox, file), null);
      if (!item || !status?.memberId) continue;
      if ('type' in item && item.type === 'task') {
        const ops = agent.taskOps();
        if (!ops.some(p => p.body.id === item.id)) {
          const current = foldBoard(ops.map(p => p.body)).find(t => t.id === item.taskId);
          const creating = !ops.some(p => p.body.taskId === item.taskId);
          if (creating || current) { // A task someone removed meanwhile is not recreated by an update.
            const body = { ...taskBody({ roomId: agent.roomId, deviceId: identity.id, memberId: status.memberId, current, taskId: item.taskId, change: item.change, removed: item.removed }), id: item.id };
            const packet = { body, signature: await agent.sign(body) };
            saveOps([...ops, packet]);
            for (const peer of peers.values()) if (peer.channel?.readyState === 'open') peer.channel.send(JSON.stringify(packet));
          }
        }
        unlinkSync(join(outbox, file)); continue;
      }
      if (!('text' in item)) continue;
      const messages = agent.messages();
      if (!messages.some(m => m.packet.body.id === item.id)) {
        const body: MessageBody = { kind: 'message', roomId: agent.roomId, id: item.id, deviceId: identity.id, memberId: status.memberId, text: item.text, at: Date.now(), ...(item.replyTo ? { replyTo: item.replyTo } : {}) };
        save([...messages, { packet: { body, signature: await agent.sign(body) }, targets: (status.devices || []).filter(d => d.id !== identity.id).map(d => d.id), receipts: [] }]);
      }
      unlinkSync(join(outbox, file));
    }
    flush();
  });

  log(`bridge running as device ${identity.id.slice(0, 12)} in ${agent.roomId}`);
  while (true) {
    try {
      const next: RoomStatus = await agent.command('status', { session, epoch, cursor });
      if (!next.memberId) { log(next.request ? `waiting for admission (${next.request.state})` : 'not admitted to this room'); await Bun.sleep(3000); continue; }
      if (epoch && next.epoch !== epoch) { for (const p of peers.values()) await p.pc.close(); peers.clear(); cursor = 0; }
      epoch = next.epoch; status = next;
      writeJson(join(agent.dir, 'members.json'), { memberId: next.memberId, members: next.members || [], devices: (next.devices || []).map(d => ({ id: d.id, memberId: d.memberId })) });
      for (const signal of next.signals || []) cursor = Math.max(cursor, signal.seq);
      const available = (next.devices || []).filter(d => d.id !== identity.id && d.session);
      for (const [id, peer] of peers) {
        if (!available.some(d => d.id === id && d.session === peer.session) || ['failed', 'closed'].includes(peer.pc.connectionState)
          || (peer.pc.connectionState !== 'connected' && Date.now() - peer.started > 20_000)) { await peer.pc.close(); peers.delete(id); }
      }
      for (const signal of next.signals || []) {
        const device = available.find(d => d.id === signal.from && d.session === signal.session); if (!device) continue;
        let peer = peers.get(device.id);
        if (signal.description.type === 'offer') {
          if (device.id > identity.id) continue;
          if (peer) await peer.pc.close(); peer = makePeer(device);
          await peer.pc.setRemoteDescription(signal.description as any);
          await describe(device.id, peer, false);
        } else if (peer?.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(signal.description as any);
      }
      for (const device of available) {
        if (identity.id < device.id && !peers.has(device.id)) {
          const peer = makePeer(device); connectChannel(peer, device.id, peer.pc.createDataChannel('meshrooms-browser-v1'));
          await describe(device.id, peer, true);
        }
      }
      await deliverOutbox();
    } catch (error) { log(`status: ${error instanceof Error ? error.message : String(error)}`); }
    await Bun.sleep(1000);
  }
}

/** Wait until this agent is addressed in the browser room (same semantics as local `listen`). */
export async function listenBrowser(agent: BrowserAgent, after: string | undefined, seconds: number, boardAfter?: number) {
  const deadline = Date.now() + seconds * 1000;
  while (true) {
    const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
    const result = evaluateWake(view, view.memberId, after, boardAfter);
    if (result.state !== 'waiting') return { roomId: agent.roomId, participantId: view.memberId, floor: view.floor, ...result };
    if (Date.now() >= deadline) return { state: 'timeout', roomId: agent.roomId, participantId: view.memberId, floor: view.floor, messages: [], cursor: after,
      boardCursor: boardAfter ?? view.boardRevision, observed: result.messages.filter(m => m.authorId !== view.memberId).length };
    await Bun.sleep(500);
  }
}

/** Queue a message for `run` to sign and deliver; waits until peers store it or the timeout passes. */
export async function sendBrowser(agent: BrowserAgent, text: string, replyTo: string | undefined, requestId: string) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  if (!text.trim() || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
  if (replyTo && !view.messages.some(m => m.id === replyTo)) throw new Error('The reply target is not in this browser room.');
  if (!mayAgentSpeak(view, view.memberId, replyTo)) throw new Error('This room is humans-first: agents speak only when a person addresses them. Reply to a message that mentions you or replies to you.');
  const id = requestId; // Stable per logical send, so a retry never duplicates.
  const outbox = join(agent.dir, 'outbox', `${Date.now()}-${id}.json`);
  if (!agent.messages().some(m => m.packet.body.id === id)) writeJson(outbox, { id, text: text.trim(), ...(replyTo ? { replyTo } : {}) });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stored = agent.messages().find(m => m.packet.body.id === id);
    if (stored && stored.receipts.length) return { messageId: id, status: 'stored-remotely', devices: stored.receipts.length };
    await Bun.sleep(300);
  }
  return { messageId: id, status: agent.messages().some(m => m.packet.body.id === id) ? 'queued-for-peers' : 'queued-for-bridge' };
}

/** Queue a task change for `run` to sign and share; returns the task once it is on this device's board. */
export async function taskBrowser(agent: BrowserAgent, input: { requestId: string; taskId?: string; revision?: number; change: TaskChange; removed?: boolean }) {
  const view = agent.view(); if (!view.memberId) throw new Error('This agent is not admitted to the browser room yet.');
  const { change } = input;
  if (change.title !== undefined && (!change.title.trim() || change.title.trim().length > 120)) throw new Error('Give the task a title of up to 120 characters.');
  if (change.notes !== undefined && change.notes.trim().length > 2000) throw new Error('Keep task notes to 2,000 characters.');
  if (change.assigneeId && !view.participants.some(p => p.id === change.assigneeId)) throw new Error('The assignee is not a member of this room.');
  const done = agent.taskOps().find(p => p.body.id === input.requestId);
  // A new task takes the request id as its task id, so retrying the same request never creates a second task.
  const taskId = input.taskId ?? input.requestId;
  if (!done && input.taskId) {
    const current = view.tasks.find(t => t.id === input.taskId);
    if (!current) throw new Error('That task is not on the board. Run tasks for current task IDs.');
    if (input.revision !== undefined && current.revision !== input.revision) throw new Error(`The task changed since you read it (now revision ${current.revision}). Read tasks again, then retry.`);
  }
  if (!done && !input.taskId && !change.title?.trim()) throw new Error('Use --title for the new task.');
  if (!done) writeJson(join(agent.dir, 'outbox', `${Date.now()}-${input.requestId}.json`), { type: 'task', id: input.requestId, taskId, change, ...(input.removed ? { removed: true } : {}) } satisfies TaskIntent);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    // Check the outbox first: `run` stores the operation before deleting the queued file.
    const pending = readdirSync(join(agent.dir, 'outbox')).some(f => f.endsWith(`-${input.requestId}.json`));
    const ops = agent.taskOps();
    if (ops.some(p => p.body.id === input.requestId)) {
      return { taskId, status: 'shared', removed: !!input.removed, task: boardTasks(ops).find(t => t.id === taskId) ?? null, boardCursor: ops.length };
    }
    if (!pending) return { taskId, status: 'dropped', reason: 'Someone removed the task before this change was signed.' };
    await Bun.sleep(300);
  }
  return { taskId, status: 'queued-for-bridge' };
}
