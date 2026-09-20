import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { MeshGuardTransport, controlCommand } from './meshguard';
import { testDirectory } from './test-directory';

test('real IPC rejects identity/capability mismatches and uses only the dedicated application inbox', async () => {
  const directory = testDirectory('control');
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\meshrooms-test-${randomUUID()}` : join(directory.path, 'control.sock');
  const key = 'a'.repeat(64), commands: string[] = []; let mode = 'ok';
  const server = createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\n')) return;
      const command = buffer.split('\n')[0]; commands.push(command);
      const value = command === 'STATUS' ? { running: true, pubkey: mode === 'wrong-key' ? 'b'.repeat(64) : key }
        : command === 'APPINFO' ? mode === 'legacy' ? { error: 'unknown command' } : { protocol: 1, maxPayload: 952 }
        : command.startsWith('APPSEND ') ? { ok: true } : { empty: true };
      const response = JSON.stringify(value) + '\n'; socket.write(response.slice(0, 4)); setImmediate(() => socket.end(response.slice(4)));
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const transport = new MeshGuardTransport(path, key); await transport.check();
    await transport.send('b'.repeat(64), '{"test":"café"}'); expect(await transport.receive()).toBeNull();
    expect(commands).toEqual(['STATUS', 'APPINFO', 'APPSEND ' + 'b'.repeat(64) + ' meshrooms-v1 {"test":"café"}', 'APPRECV meshrooms-v1']);
    mode = 'wrong-key'; await expect(transport.check()).rejects.toThrow('identity');
    mode = 'legacy'; await expect(transport.check()).rejects.toThrow('unknown command');
    await expect(controlCommand(path, 'STATUS\nSTOP')).rejects.toThrow('Invalid');
    expect(commands.filter(c => c === 'RECV')).toHaveLength(0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); directory.cleanup(); }
});
