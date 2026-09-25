import type { Task } from '../collab';
import { MAX_TASK_OPS, foldBoard, syncChunks, taskBody, validTaskBody, type TaskChange, type TaskPacket } from './board';
import { verify, type BrowserDevice, type RoomStatus } from './protocol';
import { BrowserApi } from './client';
import { read, sign, write } from './storage';

/** `replyTo` is optional so browsers from before replies keep verifying and storing these packets. */
type MessageBody = { kind: 'message'; roomId: string; id: string; deviceId: string; memberId: string; text: string; at: number; replyTo?: string };
const isId = (value: unknown) => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
type ReceiptBody = { kind: 'receipt'; roomId: string; id: string; deviceId: string };
type Packet = { body: MessageBody | ReceiptBody | TaskPacket['body']; signature: string };
export type SavedMessage = { packet: Packet & { body: MessageBody }; targets: string[]; receipts: string[] };
type Peer = { pc: RTCPeerConnection; session: string; channel?: RTCDataChannel; started: number };

/** Real browser data channels; the lobby carries connection descriptions only. */
export class BrowserPeers {
  private peers = new Map<string, Peer>();
  private status?: RoomStatus;
  private messages: SavedMessage[] = [];
  private serial: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private pendingIncoming = 0;
  private key: string;
  private boardKey: string;
  private ops: TaskPacket[] = [];
  constructor(private api: BrowserApi, private roomId: string, private deviceId: string, private session: string,
    private changed: (messages: SavedMessage[], connected: string[], added?: SavedMessage) => void, private error: (message: string) => void,
    private boardChanged: (tasks: Task[]) => void = () => {}) {
    this.key = `messages:${deviceId}:${roomId}`;
    this.boardKey = `board:${deviceId}:${roomId}`;
  }
  async load() {
    this.messages = await read<SavedMessage[]>(this.key) || []; this.ops = await read<TaskPacket[]>(this.boardKey) || [];
    this.notify(); this.notifyBoard();
  }
  private notifyBoard() { if (!this.stopped) this.boardChanged(foldBoard(this.ops.map(op => op.body))); }
  /** Keeps operations we have not seen; the board never trims, so every device folds the same history. */
  private async addOps(incoming: TaskPacket[]) {
    const fresh = incoming.filter(op => !this.ops.some(known => known.body.id === op.body.id));
    if (!fresh.length) return;
    if (this.ops.length + fresh.length > MAX_TASK_OPS) throw new Error('This room’s task board is full in this preview.');
    const next = [...this.ops, ...fresh];
    await write(this.boardKey, next); this.ops = next; this.notifyBoard();
  }
  /** Create a task (no current), change one, or remove it. Signed here and sent to every connected device. */
  async changeTask(change: TaskChange, current?: Task, removed = false) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before changing tasks.');
      const body = taskBody({ roomId: this.roomId, deviceId: this.deviceId, memberId: this.status.memberId, current, change, removed });
      const packet: TaskPacket = { body, signature: await sign(body) };
      await this.addOps([packet]);
      for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') { try { peer.channel.send(JSON.stringify(packet)); } catch { /* The board is exchanged again on reconnect. */ } }
    });
  }
  /** Operations relayed in a board exchange are checked against each author's own device, not the sender's. */
  private async acceptBoard(sync: { roomId?: unknown; ops?: unknown }) {
    if (sync.roomId !== this.roomId || !Array.isArray(sync.ops) || sync.ops.length > 500) return;
    const accepted: TaskPacket[] = [];
    for (const op of sync.ops as TaskPacket[]) {
      const author = this.status?.devices?.find(d => d.id === op?.body?.deviceId);
      if (!author || !validTaskBody(op.body, this.roomId) || op.body.memberId !== author.memberId || typeof op.signature !== 'string') continue;
      if (await verify(author.publicKey, op.body, op.signature)) accepted.push({ body: op.body, signature: op.signature });
    }
    await this.addOps(accepted);
  }
  private sendBoard(channel: RTCDataChannel) {
    for (const chunk of syncChunks(this.roomId, this.ops)) { try { channel.send(JSON.stringify(chunk)); } catch { return; } }
  }
  private notify(added?: SavedMessage) { if (!this.stopped) this.changed([...this.messages], [...this.peers].filter(([, p]) => p.channel?.readyState === 'open').map(([id]) => id), added); }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serial.then(work); this.serial = next.catch(() => {}); return next;
  }
  private async save(messages: SavedMessage[]) {
    const added = messages.length > this.messages.length ? messages.at(-1) : undefined;
    await write(this.key, messages); this.messages = messages; this.notify(added);
  }
  async send(text: string, replyTo?: string) {
    return this.transaction(async () => {
      if (!this.status?.memberId || this.stopped) throw new Error('Join the room before sending.');
      if (!text.trim() || text.length > 4000) throw new Error('Write a message of up to 4,000 characters.');
      if (this.messages.length >= 1000) throw new Error('This preview has reached its local history limit.');
      if (replyTo !== undefined && !this.messages.some(m => m.packet.body.id === replyTo)) throw new Error('The message you replied to is not in this browser.');
      const body: MessageBody = { kind: 'message', roomId: this.roomId, id: crypto.randomUUID(), deviceId: this.deviceId, memberId: this.status.memberId, text: text.trim(), at: Date.now(), ...(replyTo ? { replyTo } : {}) };
      const packet = { body, signature: await sign(body) };
      const saved: SavedMessage = { packet, targets: this.status.devices!.filter(d => d.id !== this.deviceId).map(d => d.id), receipts: [] };
      await this.save([...this.messages, saved]); this.flush();
    });
  }
  private flush() {
    for (const [id, peer] of this.peers) {
      if (peer.channel?.readyState !== 'open') continue;
      let sent = 0;
      for (const message of this.messages) {
        if (sent >= 16) break;
        if (peer.channel.bufferedAmount > 256_000) break;
        if (message.packet.body.deviceId === this.deviceId && message.targets.includes(id) && !message.receipts.includes(id)) {
          try { peer.channel.send(JSON.stringify(message.packet)); sent++; } catch { break; } // Persisted outbox retries on the next connection.
        }
      }
    }
  }
  private connectChannel(peer: Peer, id: string, channel: RTCDataChannel) {
    peer.channel = channel;
    channel.onopen = () => { this.flush(); this.sendBoard(channel); this.notify(); };
    channel.onclose = () => this.notify();
    channel.onmessage = event => {
      if (typeof event.data !== 'string' || event.data.length > 20_000 || this.pendingIncoming >= 64) return;
      this.pendingIncoming++;
      void this.transaction(async () => {
        if (this.stopped || !this.status?.memberId || this.peers.get(id) !== peer) return;
        const device = this.status.devices?.find(d => d.id === id); if (!device) return;
        let packet: Packet;
        try { packet = JSON.parse(event.data); } catch { return; }
        if ((packet as unknown as { kind?: unknown })?.kind === 'board') { await this.acceptBoard(packet as never); return; }
        const b = packet?.body;
        if (!b || b.roomId !== this.roomId || b.deviceId !== id || !isId(b.id) || typeof packet.signature !== 'string' || !await verify(device.publicKey, b, packet.signature)) return;
        if (b.kind === 'message') {
          if (b.memberId !== device.memberId || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || !Number.isSafeInteger(b.at) || b.at < 0 || b.at > 8_640_000_000_000_000) return;
          // The replied-to message may predate this browser's admission, so only its form is checked.
          if (b.replyTo !== undefined && !isId(b.replyTo)) return;
          const existing = this.messages.find(m => m.packet.body.id === b.id);
          if (existing && JSON.stringify(existing.packet.body) !== JSON.stringify(b)) return;
          if (!existing) {
            if (this.messages.length >= 1000) throw new Error('Browser history is full. New messages could not be stored.');
            await this.save([...this.messages, { packet: packet as SavedMessage['packet'], targets: [], receipts: [] }]);
          }
          // A receipt means an IndexedDB transaction completed, not that a person read it.
          const receipt: ReceiptBody = { kind: 'receipt', roomId: this.roomId, id: b.id, deviceId: this.deviceId };
          if (channel.readyState === 'open') channel.send(JSON.stringify({ body: receipt, signature: await sign(receipt) }));
        } else if (b.kind === 'receipt') {
          const m = this.messages.find(m => m.packet.body.id === b.id && m.packet.body.deviceId === this.deviceId);
          if (m?.targets.includes(id) && !m.receipts.includes(id)) await this.save(this.messages.map(x => x === m ? { ...x, receipts: [...x.receipts, id] } : x));
        } else if (b.kind === 'task') {
          if (validTaskBody(b, this.roomId) && b.memberId === device.memberId) await this.addOps([{ body: b, signature: packet.signature }]);
        }
      }).catch(e => this.error(e.message)).finally(() => { this.pendingIncoming--; });
    };
  }
  private peer(device: BrowserDevice & { session?: string }) {
    const pc = new RTCPeerConnection({ iceServers: this.status?.iceServers || [] });
    const peer: Peer = { pc, session: device.session!, started: Date.now() };
    this.peers.set(device.id, peer);
    pc.ondatachannel = event => this.connectChannel(peer, device.id, event.channel);
    pc.onconnectionstatechange = () => this.notify();
    return peer;
  }
  private async description(id: string, peer: Peer, offer: boolean) {
    await peer.pc.setLocalDescription(offer ? await peer.pc.createOffer() : await peer.pc.createAnswer());
    if (peer.pc.iceGatheringState !== 'complete') await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); peer.pc.removeEventListener('icegatheringstatechange', check); resolve(); };
      const check = () => { if (peer.pc.iceGatheringState === 'complete') finish(); };
      const timer = setTimeout(finish, 4000); peer.pc.addEventListener('icegatheringstatechange', check); check();
    });
    if (this.stopped || this.peers.get(id) !== peer) return;
    await this.api.command('signal', this.roomId, { to: id, session: this.session, targetSession: peer.session, description: peer.pc.localDescription!.toJSON() });
  }
  async update(status: RoomStatus) {
    if (this.stopped) return;
    if (this.status && this.status.epoch !== status.epoch) this.disconnect();
    this.status = status;
    const available = (status.devices || []).filter(d => d.id !== this.deviceId && d.session);
    for (const [id, peer] of this.peers) {
      if (!available.some(d => d.id === id && d.session === peer.session) || ['failed', 'closed'].includes(peer.pc.connectionState) || (peer.pc.connectionState !== 'connected' && Date.now() - peer.started > 20_000)) {
        peer.pc.close(); this.peers.delete(id);
      }
    }
    const work: Promise<unknown>[] = [];
    for (const signal of status.signals || []) {
      const device = available.find(d => d.id === signal.from && d.session === signal.session);
      if (!device) continue;
      work.push((async () => {
        let peer = this.peers.get(device.id);
        if (signal.description.type === 'offer') {
          if (device.id > this.deviceId) return;
          if (peer) peer.pc.close(); peer = this.peer(device);
          await peer.pc.setRemoteDescription(signal.description);
          await this.description(device.id, peer, false);
        } else if (peer?.pc.signalingState === 'have-local-offer') await peer.pc.setRemoteDescription(signal.description);
      })());
    }
    for (const device of available) {
      if (this.deviceId < device.id && !this.peers.has(device.id)) {
        const peer = this.peer(device); this.connectChannel(peer, device.id, peer.pc.createDataChannel('meshrooms-browser-v1'));
        work.push(this.description(device.id, peer, true));
      }
    }
    const results = await Promise.allSettled(work);
    for (const result of results) if (result.status === 'rejected' && !this.stopped) this.error('Peer connection interrupted. Reconnecting automatically.');
    this.flush(); this.notify();
  }
  private disconnect() { for (const peer of this.peers.values()) peer.pc.close(); this.peers.clear(); }
  stop() { this.stopped = true; this.disconnect(); }
}
