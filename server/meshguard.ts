import { createConnection } from 'node:net';
import { isHash } from './model';

export type IncomingPacket = { sender: string; data: string };
export interface PeerTransport {
  check(): Promise<void>;
  send(peer: string, data: string): Promise<void>;
  receive(): Promise<IncomingPacket | null>;
}

/** One command per IPC connection. Never falls back to the shared legacy inbox. */
export function controlCommand(path: string, command: string): Promise<any> {
  if (/[\r\n\0]/.test(command) || Buffer.byteLength(command) > 4096) return Promise.reject(new Error('Invalid MeshGuard command.'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path); let data = Buffer.alloc(0); let finished = false;
    const finish = (error?: Error, result?: unknown) => {
      if (finished) return; finished = true; socket.destroy(); error ? reject(error) : resolve(result);
    };
    socket.setTimeout(2500, () => finish(new Error('MeshGuard control request timed out.')));
    socket.on('error', error => finish(error));
    socket.on('connect', () => socket.write(command + '\n'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
      if (data.length > 8192) return finish(new Error('MeshGuard response exceeds the limit.'));
      const end = data.indexOf(10); if (end < 0) return;
      try {
        const result = JSON.parse(data.subarray(0, end).toString('utf8'));
        if (result?.error) return finish(new Error(`MeshGuard: ${result.error}`));
        finish(undefined, result);
      } catch { finish(new Error('Invalid MeshGuard control response.')); }
    });
    socket.on('end', () => finish(new Error('MeshGuard closed before a complete response.')));
  });
}

export class MeshGuardTransport implements PeerTransport {
  static channel = 'meshrooms-v1';
  private maxPayload = 0;
  constructor(private socketPath: string, private localKey: string) {
    if (!socketPath || !isHash(localKey)) throw new Error('An explicit MeshGuard control path and public key are required.');
  }
  async check() {
    const status = await controlCommand(this.socketPath, 'STATUS');
    if (status?.pubkey !== this.localKey || status?.running !== true) throw new Error('MeshGuard identity does not match this node attachment.');
    const info = await controlCommand(this.socketPath, 'APPINFO');
    if (info?.protocol !== 1 || !Number.isInteger(info.maxPayload) || info.maxPayload < 940) throw new Error('MeshGuard application channels v1 with at least 940-byte payloads are required.');
    this.maxPayload = Math.min(info.maxPayload, 1024);
  }
  async send(peer: string, data: string) {
    if (!isHash(peer) || !this.maxPayload || Buffer.byteLength(data) > this.maxPayload || /[\r\n\0]/.test(data)) throw new Error('Invalid application packet.');
    const result = await controlCommand(this.socketPath, `APPSEND ${peer} ${MeshGuardTransport.channel} ${data}`);
    if (result?.ok !== true) throw new Error('MeshGuard did not accept the datagram.');
  }
  async receive(): Promise<IncomingPacket | null> {
    const result = await controlCommand(this.socketPath, `APPRECV ${MeshGuardTransport.channel}`);
    if (result?.empty === true) return null;
    if (result?.ok !== true || !isHash(result.sender) || typeof result.data !== 'string' || Buffer.byteLength(result.data) > 1024) throw new Error('Invalid application inbox response.');
    return { sender: result.sender, data: result.data };
  }
}
