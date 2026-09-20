import { createHash } from 'node:crypto';
import type { Message, Participant, RoomInfo } from '../src/room';
import type { PendingRoom } from '../src/setup';

export const CATALOG_V1 = 'meshrooms/v1/catalog';
export const CATALOG = 'meshrooms/v2/catalog';
export const MAX_ROOMS = 64;
export const MAX_MESSAGES = 1000;
export const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export const isHash = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const historyKey = (roomId: string) => `meshrooms/v1/rooms/${roomId}/history`;
export type RoomPeer = { key: string; participantIds: string[]; excluded: string[]; acknowledged: string[] };
export type RoomRecord = RoomInfo & { participantIds: string[]; requestId: string; fingerprint: string; peer?: RoomPeer };
export type IntentRecord = PendingRoom & { agentId: string; tokenHash: string; fingerprint: string };
export type Settings = { completed: boolean; machineName: string; startAtLogin: boolean };
export type Catalog = {
  version: 3; nodeId: string; ownerId: string; participants: Participant[]; rooms: RoomRecord[];
  settings: Settings; intents: IntentRecord[]; setupReceipts: { id: string; fingerprint: string; roomId?: string }[];
};
export type StoredMessage = Message & { requestId: string; fingerprint: string };
export type History = { version: 1 | 2; roomId: string; messages: StoredMessage[] };
export type Principal = { kind: 'owner'; participantId: string } | { kind: 'agent'; participantId: string; roomId: string };

function named(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max; }
function participant(value: any): value is Participant {
  return !!value && isUuid(value.id) && named(value.name, 64) && ['human', 'agent'].includes(value.role)
    && (value.state === 'local' ? value.peerKey === undefined : value.state === 'remote' && isHash(value.peerKey)) && typeof value.detail === 'string';
}
function unique(values: unknown[]): boolean { return new Set(values).size === values.length; }
export function validCatalog(value: any): value is Catalog {
  if (!value || value.version !== 3 || !isUuid(value.nodeId) || !isUuid(value.ownerId)
    || !Array.isArray(value.participants) || !value.participants.every(participant) || !unique(value.participants.map((p: Participant) => p.id))
    || !Array.isArray(value.rooms) || value.rooms.length > MAX_ROOMS || !unique(value.rooms.map((r: RoomRecord) => r?.id))
    || !unique(value.rooms.map((r: RoomRecord) => r?.requestId))
    || !value.settings || typeof value.settings.completed !== 'boolean' || !named(value.settings.machineName, 64) || typeof value.settings.startAtLogin !== 'boolean'
    || !Array.isArray(value.intents) || value.intents.length > MAX_ROOMS || !unique(value.intents.map((i: IntentRecord) => i?.id))
    || !unique(value.intents.map((i: IntentRecord) => i?.agentId)) || !unique(value.intents.map((i: IntentRecord) => i?.tokenHash))
    || !Array.isArray(value.setupReceipts) || value.setupReceipts.length > 256 || !unique(value.setupReceipts.map((r: any) => r?.id))) return false;
  const people = new Map<string, Participant>(value.participants.map((p: Participant) => [p.id, p]));
  if (people.get(value.ownerId)?.role !== 'human' || people.get(value.ownerId)?.state !== 'local'
    || value.participants.filter((p: Participant) => p.role === 'human' && p.state === 'local').length !== 1) return false;
  if (!value.rooms.every((r: any) => r && isUuid(r.id) && isUuid(r.requestId) && isHash(r.fingerprint)
    && named(r.title, 64) && typeof r.project === 'string' && r.project.length <= 48 && r.sample === false
    && Array.isArray(r.participantIds) && unique(r.participantIds) && r.participantIds.includes(value.ownerId)
    && r.participantIds.every((id: string) => people.has(id))
    && (r.peer === undefined ? r.participantIds.every((id: string) => people.get(id)?.state === 'local')
      : isHash(r.peer.key) && Array.isArray(r.peer.participantIds) && r.peer.participantIds.length > 0 && r.peer.participantIds.length <= 16
        && unique(r.peer.participantIds) && r.peer.participantIds.every((id: string) => r.participantIds.includes(id) && people.get(id)?.peerKey === r.peer.key)
        && r.participantIds.every((id: string) => people.get(id)?.state === 'local' || r.peer.participantIds.includes(id))
        && [r.peer.excluded, r.peer.acknowledged].every(ids => Array.isArray(ids) && ids.length <= MAX_MESSAGES && unique(ids) && ids.every(isUuid))))) return false;
  if (!value.intents.every((i: any) => i && isUuid(i.id) && isUuid(i.agentId) && isHash(i.tokenHash) && isHash(i.fingerprint)
    && named(i.title, 64) && named(i.agentName, 64) && typeof i.project === 'string' && i.project.length <= 48
    && (i.status === 'pending' ? i.roomId === undefined && !people.has(i.agentId)
      : i.status === 'completed' && i.roomId === i.id && people.get(i.agentId)?.role === 'agent'
        && value.rooms.some((r: RoomRecord) => r.id === i.roomId && r.participantIds.includes(i.agentId))))) return false;
  return value.setupReceipts.every((r: any) => r && isUuid(r.id) && isHash(r.fingerprint)
    && (r.roomId === undefined || value.rooms.some((room: RoomRecord) => room.id === r.roomId)));
}

export function migrateV1(value: any, machineName: string): Catalog {
  const owner = value?.localParticipant;
  if (!value || value.version !== 1 || !isUuid(value.nodeId) || !participant(owner) || owner.role !== 'human'
    || !Array.isArray(value.rooms) || !value.rooms.every((room: any) => Array.isArray(room?.participants)
      && room.participants.length === 1 && room.participants[0].id === owner.id && participant(room.participants[0]))) throw new Error('Invalid legacy catalog');
  const result: Catalog = {
    version: 3, nodeId: value.nodeId, ownerId: owner.id, participants: [owner],
    rooms: value.rooms.map(({ participants: _, ...room }: any) => ({ ...room, participantIds: [owner.id] })),
    settings: { completed: false, machineName, startAtLogin: false }, intents: [], setupReceipts: [],
  };
  if (!validCatalog(result)) throw new Error('Invalid legacy catalog');
  return result;
}

export function migrateV2(value: any): Catalog {
  if (!value || value.version !== 2 || !Array.isArray(value.rooms) || value.rooms.some((r: any) => r?.peer !== undefined)
    || !Array.isArray(value.participants) || value.participants.some((p: any) => p?.state !== 'local' || p?.peerKey !== undefined)) throw new Error('Invalid v2 catalog');
  const next = { ...value, version: 3 };
  if (!validCatalog(next)) throw new Error('Invalid v2 catalog');
  return next;
}

export function validHistory(value: any, room: RoomRecord, people: Participant[]): value is History {
  if (!value || ![1, 2].includes(value.version) || value.roomId !== room.id || !Array.isArray(value.messages) || value.messages.length > MAX_MESSAGES) return false;
  const ids = new Set<string>(); const requests = new Set<string>();
  return value.messages.every((m: any) => {
    const author = people.find(p => p.id === m?.authorId && room.participantIds.includes(p.id));
    if (!m || !author || !isUuid(m.id) || ids.has(m.id) || !isUuid(m.requestId) || requests.has(`${m.authorId}:${m.requestId}`)
      || !named(m.author, 64) || m.role !== author.role || (value.version === 1 && m.role !== 'human')
      || typeof m.text !== 'string' || m.text.length > 4000 || typeof m.time !== 'string' || !Number.isFinite(Date.parse(m.time))
      || !isHash(m.fingerprint) || m.sample === true || (m.replyTo !== undefined && !ids.has(m.replyTo))) return false;
    if (m.share !== undefined && (!m.share || !named(m.share.title, 100) || !named(m.share.text, 8000))) return false;
    if (!m.text.trim() && !m.share) return false;
    ids.add(m.id); requests.add(`${m.authorId}:${m.requestId}`); return true;
  });
}

export function recover<T>(raw: string, name: string, valid: (value: any) => boolean): T {
  try { const value = JSON.parse(raw); if (!valid(value)) throw new Error('Invalid schema'); return value; }
  catch { throw new Error(`Cannot recover ${name}: invalid stored data. The store has not been reset.`); }
}
