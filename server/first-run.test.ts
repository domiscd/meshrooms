import { expect, test } from 'bun:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalNode } from './node';
import { CATALOG, CATALOG_V1, fingerprint, historyKey, tokenHash } from './model';
import { startDaemon, defaultOptions } from './daemon';
import { testStartupManager } from './startup';
import { testDirectory } from './test-directory';
import { NodeAccess } from './access';
import { runCli } from './cli';
import { ensureRunning, probeRuntime } from './runtime';

test('v1 migration preserves old authors and requests; setup adds a separately authorized agent and recovers', () => {
  const ownerId = randomUUID(), roomId = randomUUID(), nodeId = randomUUID(), messageId = randomUUID(), requestId = randomUUID();
  const owner = { id: ownerId, name: 'You', role: 'human', state: 'local', detail: 'Local participant · room member' };
  const records = new Map<string, string>([
    [CATALOG_V1, JSON.stringify({ version: 1, nodeId, localParticipant: owner, rooms: [{ id: roomId, title: 'Existing work', project: 'Project', sample: false,
      participants: [owner], requestId: roomId, fingerprint: fingerprint({ title: 'Existing work', project: 'Project' }) }] })],
    [historyKey(roomId), JSON.stringify({ version: 1, roomId, messages: [{ id: messageId, authorId: ownerId, author: 'You', role: 'human', text: 'Keep this history',
      time: new Date().toISOString(), requestId, fingerprint: fingerprint({ text: 'Keep this history' }) }] })],
  ]);
  const original = records.get(CATALOG_V1);
  const store = () => ({ read: (key: string) => records.get(key) ?? null, write: (key: string, value: string) => { records.set(key, value); }, close() {} });
  const node = new LocalNode(store()); expect(records.has(CATALOG)).toBe(true);
  const intentId = randomUUID(), secret = randomBytes(32).toString('base64url');
  const prepare = { requestId: intentId, title: 'With an agent', project: 'Project', agentName: 'Codex', credentialHash: tokenHash(secret) };
  node.prepareRoom(prepare); expect(node.prepareRoom(prepare).id).toBe(intentId); expect(node.authenticateAgent(secret)).toBeUndefined();
  expect(node.snapshot().rooms).toHaveLength(1);
  const command = { requestId: randomUUID(), humanName: 'Igor', machineName: 'Workstation', startAtLogin: false, intentId };
  expect(node.completeSetup(command)).toEqual({ roomId: intentId }); expect(node.completeSetup(command)).toEqual({ roomId: intentId });
  const agent = node.authenticateAgent(secret)!;
  expect(node.snapshot(agent).rooms.map(r => r.id)).toEqual([intentId]);
  expect(() => node.send({ roomId, requestId: randomUUID(), text: 'No cross-room write' }, agent)).toThrow('not available');
  expect(() => node.createRoom({ requestId: randomUUID(), title: 'Denied' }, agent)).toThrow('human session');
  node.send({ roomId: intentId, requestId, text: 'Agent authored' }, agent);
  node.send({ roomId: intentId, requestId, text: 'Human authored' });
  const access = new NodeAccess(secret, node); const cookie = access.exchangeBrowserTicket(access.issueBrowserTicket()).split(';')[0];
  node.close();
  const restored = new LocalNode(store());
  try {
    expect(records.get(CATALOG_V1)).toBe(original);
    expect(restored.nodeId).toBe(nodeId); expect(restored.settings.humanName).toBe('Igor');
    expect(restored.snapshot().rooms[0].messages[0].author).toBe('You');
    expect(restored.snapshot().rooms[1].messages.map(m => [m.author, m.role])).toEqual([['Codex', 'agent'], ['Igor', 'human']]);
    expect(restored.send({ roomId: intentId, requestId, text: 'Agent authored' }, restored.authenticateAgent(secret)!).messageId).toBe(restored.snapshot().rooms[1].messages[0].id);
    expect(new NodeAccess(secret, restored).principal(new Request('http://127.0.0.1:4318', { headers: { Cookie: cookie } }))).toEqual(restored.owner);
  } finally { restored.close(); }
});

test('real HTTP setup requires acceptance, enforces identity/scope, and exposes only live agent connection state', async () => {
  const directory = testDirectory('setup-http');
  const startup = testStartupManager();
  const daemon = startDaemon({ ...defaultOptions(), dataDir: directory.path, port: 0, startup });
  const root = `http://127.0.0.1:${daemon.server.port}/api/node/`;
  const control = readFileSync(join(directory.path, 'control.key'), 'utf8').trim();
  const owner = { Authorization: `Bearer ${control}` };
  const request = (path: string, headers: Record<string, string>, body?: unknown) => fetch(root + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    expect((await request('snapshot', {})).status).toBe(401);
    const intentId = randomUUID(), secret = randomBytes(32).toString('base64url');
    const prepared = await request('control/prepare', owner, { requestId: intentId, title: 'A', project: 'Test', agentName: 'Worker', credentialHash: tokenHash(secret) });
    expect(prepared.status).toBe(201);
    expect((await request('snapshot', { Authorization: `Bearer ${secret}` })).status).toBe(401);
    const ticketResponse = await request('control/browser', owner, {}); const { ticket } = await ticketResponse.json();
    const login = await request('session', {}, { ticket }); expect(login.status).toBe(200);
    const cookie = { Cookie: login.headers.get('set-cookie')!.split(';')[0] };
    expect((await request('session', {}, { ticket })).status).toBe(401);
    const setup = await (await request(`setup?intent=${intentId}`, cookie)).json(); expect(setup.completed).toBe(false);
    expect(daemon.node.snapshot().rooms).toHaveLength(0);
    const command = { requestId: randomUUID(), humanName: 'Human', machineName: 'Desktop', startAtLogin: true, intentId };
    expect((await request('setup', { ...cookie, Origin: 'https://untrusted.example' }, command)).status).toBe(403);
    expect(await (await request('setup', cookie, command)).json()).toEqual({ roomId: intentId });
    expect(startup.status().installed).toBe(true);
    expect((await request('setup', cookie, { ...command, humanName: 'Changed retry' })).status).toBe(409);
    expect(await (await request('setup', cookie, command)).json()).toEqual({ roomId: intentId });
    const other = await (await request('rooms', owner, { requestId: randomUUID(), title: 'Private B' })).json();
    const agent = { Authorization: `Bearer ${secret}` };
    expect((await request('setup', agent)).status).toBe(403);
    expect((await request('control/browser', agent, {})).status).toBe(403);
    expect((await request('messages', agent, { requestId: randomUUID(), roomId: other.roomId, text: 'Rejected' })).status).toBe(404);
    expect((await request('messages', agent, { requestId: randomUUID(), roomId: intentId, text: 'Agent message', authorId: daemon.node.owner.participantId })).status).toBe(201);
    const scoped = await (await request('snapshot', agent)).json(); expect(scoped.rooms).toHaveLength(1);
    expect(scoped.rooms[0].messages[0].role).toBe('agent'); expect(scoped.rooms[0].messages[0].author).toBe('Worker');
    const abort = new AbortController();
    const stream = await fetch(`${root}events?view=agent-test`, { headers: agent, signal: abort.signal });
    const reader = stream.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).not.toContain('Private B');
    expect(daemon.node.snapshot().rooms[0].participants.find(p => p.role === 'agent')!.connected).toBe(true);
    abort.abort(); await reader.cancel().catch(() => {});
  } finally { daemon.close(); directory.cleanup(); }
});

test('CLI start/retry and simultaneous ensure reuse the actual daemon; agent CLI uses only the admitted room', async () => {
  const directory = testDirectory('first-run-cli');
  const options = { ...defaultOptions(), dataDir: directory.path, port: 0 };
  let runtime: Awaited<ReturnType<typeof ensureRunning>> | undefined;
  try {
    const pair = await Promise.all([ensureRunning(options), ensureRunning(options)]); runtime = pair[0]; expect(pair[1]).toEqual(runtime);
    const args = ['start', '--data-dir', directory.path, '--port', '0', '--title', 'CLI room', '--agent', 'CLI agent', '--project', 'Test'];
    const started: any = await runCli(args); expect(started.state).toBe('needs-onboarding');
    const retried: any = await runCli(args); expect(retried.intentId).toBe(started.intentId); expect(retried.credentialFile).toBe(started.credentialFile);
    expect(await probeRuntime(directory.path)).toEqual(runtime);
    const control = readFileSync(join(directory.path, 'control.key'), 'utf8').trim();
    const setupResponse = await fetch(new URL('/api/node/setup', runtime.url), { method: 'POST', headers: { Authorization: `Bearer ${control}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: randomUUID(), humanName: 'Person', machineName: 'CLI test machine', startAtLogin: false, intentId: started.intentId }) });
    expect(setupResponse.status).toBe(200);
    const ready: any = await runCli(args); expect(ready.state).toBe('ready');
    const messageId = randomUUID(); const sent: any = await runCli(['send', '--credential', started.credentialFile, '--request-id', messageId, '--text', 'Hello from a real CLI']);
    expect(sent.status).toBe('stored-locally');
    const read: any = await runCli(['read', '--credential', started.credentialFile]); expect(read.rooms).toHaveLength(1);
    expect(read.rooms[0].messages[0].author).toBe('CLI agent');
    const received: any = await runCli(['listen', '--credential', started.credentialFile, '--wait-seconds', '1']); expect(received.messages[0].id).toBe(sent.messageId);
  } finally {
    if (runtime) { process.kill(runtime.pid, 'SIGKILL'); for (let i = 0; i < 30; i++) { try { process.kill(runtime.pid, 0); await Bun.sleep(20); } catch { break; } } }
    directory.cleanup();
  }
}, 30000);
