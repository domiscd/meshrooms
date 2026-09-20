import { isHash, isUuid } from './model';
import type { Role } from '../src/room';

export type RoomDescriptor = { version: 1; roomId: string; peerKey: string; participants: { id: string; name: string; role: Role }[] };

/** A locally approved, fixed two-node grant. This is not an invitation token. */
export function parseDescriptor(value: any): RoomDescriptor {
  if (!value || value.version !== 1 || !isUuid(value.roomId) || !isHash(value.peerKey)
    || !Array.isArray(value.participants) || value.participants.length < 1 || value.participants.length > 16
    || new Set(value.participants.map((p: any) => p?.id)).size !== value.participants.length
    || value.participants.some((p: any) => !p || !isUuid(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 64 || !['human', 'agent'].includes(p.role))) {
    throw new Error('Invalid room pairing descriptor.');
  }
  return { version: 1, roomId: value.roomId, peerKey: value.peerKey, participants: value.participants.map(({ id, name, role }: any) => ({ id, name, role })) };
}
