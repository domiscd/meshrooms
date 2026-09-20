import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defaultOptions } from './daemon';
import { fingerprint, isUuid, tokenHash } from './model';
import { ensureRunning, probeRuntime, type RuntimeRecord } from './runtime';
import type { NodeSnapshot } from '../src/room';

type ClientCredential = { version: 1; nodeId: string; dataDir: string; intentId: string; token: string; title: string; project: string; agentName: string };
function parse(args: string[]) {
  const command = args[0] || 'help'; const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    const key = args[i]; const value = args[++i];
    if (!key.startsWith('--') || value === undefined || Object.hasOwn(values, key)) throw new Error(`Use one value for ${key}.`);
    values[key] = value;
  }
  const allowed = ['--data-dir', '--library', '--port', '--dev-origin', '--title', '--project', '--agent', '--request-id', '--credential', '--text', '--after', '--wait-seconds'];
  for (const key of Object.keys(values)) if (!allowed.includes(key)) throw new Error(`Unknown option ${key}.`);
  return { command, values };
}
function requireText(value: string | undefined, name: string, max: number) {
  if (!value?.trim() || value.length > max) throw new Error(`${name} must contain 1–${max} characters.`); return value.trim();
}
function readCredential(file: string): ClientCredential {
  const value = JSON.parse(readFileSync(file, 'utf8'));
  if (value.version !== 1 || !isUuid(value.nodeId) || !isUuid(value.intentId) || typeof value.dataDir !== 'string'
    || typeof value.token !== 'string' || !/^[\w-]{43}$/.test(value.token)
    || !['title', 'project', 'agentName'].every(key => typeof value[key] === 'string')) throw new Error('Invalid agent credential file. Do not replace it; recover the original file.');
  return value;
}
function createCredential(file: string, value: ClientCredential): ClientCredential {
  if (existsSync(file)) return readCredential(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  try { linkSync(temporary, file); }
  catch (error) { if (!existsSync(file)) throw error; }
  finally { unlinkSync(temporary); }
  return readCredential(file);
}
async function api(record: RuntimeRecord, token: string, path: string, body?: unknown) {
  const response = await fetch(new URL(`/api/node/${path}`, record.url), { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || `Local request failed (${response.status}).`);
  return result;
}
async function ownerToken(dataDir: string, runtime: RuntimeRecord): Promise<string> {
  const confirmed = await probeRuntime(dataDir);
  if (!confirmed || confirmed.instanceId !== runtime.instanceId) throw new Error('The daemon changed during setup. Retry the same command.');
  return readFileSync(join(dataDir, 'control.key'), 'utf8').trim();
}
async function listen(record: RuntimeRecord, credential: ClientCredential, after: string | undefined, seconds: number) {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('Use --wait-seconds between 1 and 60.');
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), seconds * 1000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(new URL(`/api/node/events?view=agent-${randomUUID()}`, record.url), {
      headers: { Authorization: `Bearer ${credential.token}` }, signal: abort.signal, redirect: 'error' });
    if (!response.ok) throw new Error((await response.json()).message || 'Agent connection was rejected.');
    reader = response.body!.getReader(); let buffered = ''; const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) throw new Error('The daemon closed the agent connection.');
      buffered += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const event = buffered.slice(0, end); buffered = buffered.slice(end + 2);
        if (!event.startsWith('data: ')) continue;
        const snapshot = JSON.parse(event.slice(6)) as NodeSnapshot;
        const room = snapshot.rooms.find(r => r.id === credential.intentId); if (!room) throw new Error('The agent is no longer admitted to this room.');
        const index = after ? room.messages.findIndex(m => m.id === after) : -1;
        if (after && index < 0) throw new Error('The supplied cursor is not in this room. Read the room to establish a cursor.');
        const messages = room.messages.slice(index + 1);
        if (messages.length) return { state: 'messages', roomId: room.id, messages, cursor: messages.at(-1)!.id };
      }
    }
  } catch (error) { if (abort.signal.aborted) return { state: 'timeout', roomId: credential.intentId, messages: [], cursor: after }; throw error; }
  finally { clearTimeout(timer); abort.abort(); if (reader) await reader.cancel().catch(() => {}); }
}

export async function runCli(args: string[]): Promise<unknown> {
  const { command, values } = parse(args);
  if (command === 'help') return { commands: ['status', 'ensure', 'open', 'start --title NAME --agent NAME [--project LABEL]',
    'read --credential PATH', 'send --credential PATH --request-id UUID --text TEXT', 'listen --credential PATH [--after MESSAGE_ID] [--wait-seconds 30]'],
    options: ['--data-dir PATH', '--library PATH', '--port NUMBER', '--dev-origin URL'], note: 'Browser links expire after two minutes. Agent credential files stay private on this machine.' };
  if (!['status', 'ensure', 'open', 'start', 'read', 'send', 'listen'].includes(command)) throw new Error(`Unknown command ${command}. Run help.`);
  if (['read', 'send', 'listen'].includes(command)) {
    const credential = readCredential(resolve(requireText(values['--credential'], '--credential', 4096)));
    const runtime = await probeRuntime(credential.dataDir);
    if (!runtime || runtime.nodeId !== credential.nodeId) throw new Error('This agent credential has no matching running node. Ask the Meshrooms skill to reopen the existing node.');
    if (command === 'listen') return listen(runtime, credential, values['--after'], Number(values['--wait-seconds'] || 30));
    if (command === 'read') return api(runtime, credential.token, 'snapshot');
    const id = values['--request-id']; if (!isUuid(id)) throw new Error('Use --request-id with a UUID and retain it for uncertain retries.');
    const text = requireText(values['--text'], '--text', 4000);
    return api(runtime, credential.token, 'messages', { roomId: credential.intentId, requestId: id, text });
  }
  const options = defaultOptions();
  if (values['--data-dir']) options.dataDir = resolve(values['--data-dir']);
  if (values['--library']) options.libraryPath = resolve(values['--library']);
  if (values['--port'] !== undefined) options.port = Number(values['--port']);
  if (values['--dev-origin']) options.devOrigin = values['--dev-origin'];
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Use a valid port.');
  if (command === 'status') return { state: 'status', runtime: await probeRuntime(options.dataDir) };
  // Validate intent fields before starting a process or preparing private files.
  const title = command === 'start' ? requireText(values['--title'], '--title', 64) : '';
  const agentName = command === 'start' ? requireText(values['--agent'], '--agent', 64) : '';
  const project = values['--project']?.trim() || ''; if (project.length > 48) throw new Error('--project must be at most 48 characters.');
  if (values['--request-id'] !== undefined && !isUuid(values['--request-id'])) throw new Error('--request-id must be a UUID.');
  const runtime = await ensureRunning(options);
  if (command === 'ensure') return runtime;
  const token = await ownerToken(options.dataDir, runtime);
  let intentId: string | undefined; let credentialFile: string | undefined; let state = 'ready';
  if (command === 'start') {
    const directory = join(options.dataDir, 'clients'); mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = values['--request-id']?.toLowerCase() || fingerprint({ title, project, agentName, workspace: realpathSync(process.cwd()) });
    credentialFile = join(directory, `${key}.json`);
    const credential = createCredential(credentialFile, { version: 1, nodeId: runtime.nodeId, dataDir: realpathSync(options.dataDir),
      intentId: values['--request-id']?.toLowerCase() || randomUUID(), token: randomBytes(32).toString('base64url'), title, project, agentName });
    if (credential.nodeId !== runtime.nodeId || credential.title !== title || credential.project !== project || credential.agentName !== agentName) throw new Error('This request ID already describes different room details. Reuse its original details or choose a new request ID.');
    const pending = await api(runtime, token, 'control/prepare', { requestId: credential.intentId, title, project, agentName, credentialHash: tokenHash(credential.token) });
    intentId = pending.id;
    const setup = await api(runtime, token, `setup?intent=${intentId}`);
    state = !setup.completed ? 'needs-onboarding' : pending.status === 'pending' ? 'needs-room-review' : 'ready';
  }
  const { ticket } = await api(runtime, token, 'control/browser', {});
  const url = new URL(runtime.url); if (intentId) url.searchParams.set('setup', intentId); url.hash = `access=${ticket}`;
  return { state, url: url.href, nodeId: runtime.nodeId, intentId, credentialFile };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runCli(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
