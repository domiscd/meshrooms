/** Browser-room v1 is independent of the native node's credentials and grants. */
export const browserProtocol = 'meshrooms-browser-v1';
export type Command = {
  protocol: typeof browserProtocol; origin: string; id: string; at: number;
  action: 'create' | 'request' | 'cancel' | 'status' | 'decide' | 'link' | 'remove' | 'signal';
  roomId: string; payload: Record<string, unknown>;
};
export type SignedCommand = { command: Command; publicKey: string; signature: string };
export type BrowserDevice = { id: string; publicKey: string; label: string; memberId: string; admittedAt: number };
export type BrowserMember = { id: string; name: string };
export type JoinRequest = {
  id: string; device: BrowserDevice; name: string; kind: 'person' | 'companion';
  state: 'pending' | 'admitted' | 'declined' | 'expired'; expiresAt: number; code?: string; linkedMemberId?: string;
};
export type Signal = { seq: number; from: string; session: string; targetSession: string; description: RTCSessionDescriptionInit };
export type RoomStatus = {
  roomId: string; title: string; epoch: string; hostOnline: boolean; memberId?: string; ownerId?: string;
  deviceId: string; request?: JoinRequest; requests?: JoinRequest[];
  members?: BrowserMember[]; devices?: (BrowserDevice & { session?: string })[];
  signals?: Signal[]; iceServers?: RTCIceServer[];
};
export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export function base64(bytes: ArrayBuffer) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
export function unbase64(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
export async function deviceId(publicKey: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', unbase64(publicKey))), n => n.toString(16).padStart(2, '0')).join('');
}
export async function verify(publicKey: string, value: unknown, signature: string) {
  try {
    if (publicKey.length !== 88 || signature.length !== 88) return false;
    const key = await crypto.subtle.importKey('raw', unbase64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unbase64(signature), encode(value));
  } catch { return false; }
}
