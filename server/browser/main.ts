import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { BrowserLobby } from './lobby';
import { browserHandler } from './http';
import { acquireInstance } from '../instance';

const port = Number(process.env.MESHROOMS_BROWSER_PORT || 4320);
const origin = process.env.MESHROOMS_BROWSER_ORIGIN || `http://127.0.0.1:${port}`;
const url = new URL(origin);
if (url.origin !== origin || (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))) throw new Error('Use an HTTPS origin, or loopback for local development.');
const dir = resolve(process.env.MESHROOMS_BROWSER_DATA || '.local/browser-rooms');
mkdirSync(dir, { recursive: true });
const release = acquireInstance(dir);
const urls = (value?: string) => value?.split(',').map(s => s.trim()).filter(Boolean);
const lobby = new BrowserLobby(resolve(dir, 'admission.sqlite'), { origin,
  stunUrls: urls(process.env.MESHROOMS_STUN_URLS), turnUrls: urls(process.env.MESHROOMS_TURN_URLS), turnSecret: process.env.MESHROOMS_TURN_SECRET });
const handle = browserHandler(lobby, origin, resolve('dist'), {
  trustLoopbackProxy: process.env.MESHROOMS_TRUST_LOOPBACK_PROXY === '1',
  apiLimit: process.env.MESHROOMS_TRUST_LOOPBACK_PROXY === '1' ? 1200 : 240,
  revision: process.env.MESHROOMS_REVISION,
});
const server = Bun.serve({ hostname: '127.0.0.1', port, maxRequestBodySize: 24_000,
  fetch: (request, server) => handle(request, server.requestIP(request)?.address || 'unknown') });
console.log(`Browser rooms: ${origin}/rooms (listening on loopback port ${server.port})`);
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.stop(true); lobby.close(); release(); process.exit(0); });
