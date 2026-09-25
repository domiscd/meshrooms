import { resolve, sep } from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { BrowserLobby, LobbyError } from './lobby';

const explainer = fileURLToPath(new URL('./agent-join.md', import.meta.url));
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** The page for people shows the same Markdown agents read, escaped, so nothing can render differently. */
const explainerHtml = (markdown: string, roomId: string) => '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
  + `<meta name="robots" content="noindex"><title>Connect an agent · Meshrooms</title></head><body><main><p><a href="/agent/${roomId}.md">Plain Markdown</a></p><pre>${escape(markdown)}</pre></main></body></html>`;
/** A host chooses the room title, so it may not carry Markdown or look like instructions set apart from the text. */
const plainTitle = (title: string) => title.replace(/[`*_[\]<>#|\\]/g, '').trim() || 'Untitled room';

export type BrowserHttpOptions = { trustLoopbackProxy?: boolean; apiLimit?: number; createLimit?: number; revision?: string; now?: () => number };
export function browserHandler(lobby: BrowserLobby, origin: string, distDir: string, options: BrowserHttpOptions = {}) {
  const allowed = new URL(origin);
  const root = resolve(distDir);
  const rates = new Map<string, { at: number; count: number }>();
  const creates = new Map<string, { at: number; count: number }>();
  const now = options.now || Date.now;
  function charge(map: typeof rates, key: string, window: number, limit: number) {
    const at = now();
    for (const [key, rate] of map) if (at - rate.at >= window) map.delete(key);
    if (!map.has(key) && map.size >= 4096) return false;
    const rate = map.get(key) || { at, count: 0 };
    map.set(key, rate);
    return ++rate.count <= limit;
  }
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
  return async (request: Request, remoteAddress = 'local'): Promise<Response> => {
    const url = new URL(request.url);
    if ((request.headers.get('host') || url.host) !== allowed.host) return json({ error: 'Unexpected host.' }, 403);
    if (request.headers.get('origin') && request.headers.get('origin') !== origin) return json({ error: 'Unexpected origin.' }, 403);
    // Nginx must overwrite this header. Direct clients can never choose their quota key.
    let address = remoteAddress;
    if (options.trustLoopbackProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remoteAddress)) {
      const forwarded = request.headers.get('x-real-ip');
      if (forwarded && isIP(forwarded)) address = forwarded;
    }
    try {
      if (url.pathname.startsWith('/api/lobby')) {
        if (!charge(rates, address, 60_000, options.apiLimit || 240)) return json({ error: 'Too many requests. Try again shortly.' }, 429);
        if (url.pathname === '/api/lobby/health' && request.method === 'GET') return json({ ok: lobby.healthy(), revision: options.revision || 'development' });
        if (request.method === 'GET' && /^\/api\/lobby\/rooms\/[a-f0-9-]{36}$/.test(url.pathname)) return json(lobby.publicRoom(url.pathname.split('/').at(-1)!));
        if (url.pathname !== '/api/lobby' || request.method !== 'POST') return json({ error: 'Not found.' }, 404);
        if (request.headers.get('origin') !== origin || request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Use the room application to submit requests.' }, 403);
        // Enforce the streamed limit, not only a client-supplied Content-Length.
        const reader = request.body?.getReader();
        if (!reader) return json({ error: 'Request body required.' }, 400);
        const chunks: Uint8Array[] = []; let length = 0;
        try {
          while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 24_000) { await reader.cancel(); return json({ error: 'Request too large.' }, 413); } chunks.push(part.value); }
        } finally { reader.releaseLock(); }
        let input: unknown;
        try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json({ error: 'Invalid request.' }, 400); }
        if ((input as { command?: { action?: string } })?.command?.action === 'create' &&
          !charge(creates, address, 3_600_000, options.createLimit || 6)) return json({ error: 'Room creation limit reached. Try again in an hour.' }, 429);
        return json(await lobby.execute(input as Parameters<BrowserLobby['execute']>[0]));
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'Method not allowed.' }, 405);
      // The agent bridge is built from the same commit at deploy, next to the browser assets.
      const bundle = /^\/agent\/meshrooms-agent\.js(\.sha256)?$/.exec(url.pathname);
      if (bundle) {
        const file = Bun.file(resolve(root, 'agent', `meshrooms-agent.js${bundle[1] || ''}`));
        if (!await file.exists()) return json({ error: 'The agent bridge is not built on this server.' }, 404);
        return new Response(request.method === 'HEAD' ? null : file, { headers: { ...headers, 'Content-Type': bundle[1] ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8' } });
      }
      // The agent link's token lives in the URL fragment, so it never reaches this server or its logs.
      const agentPage = /^\/agent\/([a-f0-9-]{36})(\.md)?$/.exec(url.pathname);
      if (agentPage) {
        const room = lobby.publicRoom(agentPage[1]);
        const digest = Bun.file(resolve(root, 'agent', 'meshrooms-agent.js.sha256'));
        const sha256 = await digest.exists() ? (await digest.text()).split(/\s/)[0] : 'unavailable: the agent bridge is not built on this server';
        const text = (await Bun.file(explainer).text()).replaceAll('{{ORIGIN}}', origin).replaceAll('{{ROOM_ID}}', room.roomId)
          .replaceAll('{{ROOM_TITLE}}', plainTitle(room.title)).replaceAll('{{BUNDLE_SHA256}}', sha256);
        const body = agentPage[2] ? text : explainerHtml(text, room.roomId);
        return new Response(request.method === 'HEAD' ? null : body, { headers: { ...headers, 'Content-Type': agentPage[2] ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8' } });
      }
      const route =url.pathname === '/rooms' || /^\/r\/[a-f0-9-]{36}$/.test(url.pathname);
      const relative = route ? 'index.html' : url.pathname.replace(/^\//, '');
      if (!route && !/^assets\/[a-zA-Z0-9_.-]+$/.test(relative)) return json({ error: 'Not found.' }, 404);
      const path = resolve(root, relative);
      if (!path.startsWith(root + sep)) return json({ error: 'Not found.' }, 404);
      const file = Bun.file(path);
      if (!await file.exists()) return json({ error: 'Build the browser application first.' }, 404);
      return new Response(request.method === 'HEAD' ? null : file, { headers });
    } catch (error) {
      if (error instanceof LobbyError) return json({ error: error.message }, error.status);
      return json({ error: 'The room service could not finish this request. Try again.' }, 500);
    }
  };
}
