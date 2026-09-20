import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startupHostStatus } from './windows-path';

export type StartupState = { installed: boolean; supported: boolean; message?: string };
export interface StartupManager { status(): StartupState; apply(enabled: boolean): StartupState }
export type StartupOptions = { dataDir: string; libraryPath: string; port: number; cliPath: string; executable?: string };
const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const quotePS = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** HKCU registration is per-user and is applied only for an explicit settings command. */
export function startupManager(options: StartupOptions): StartupManager {
  if (process.platform !== 'win32') return { status: () => ({ installed: false, supported: false, message: 'Start at login is currently available on Windows.' }),
    apply(enabled) { if (enabled) throw new Error('Start at login is not supported on this platform yet.'); return this.status(); } };
  const host = startupHostStatus();
  if (!host.supported) return { status: () => ({ installed: false, ...host }),
    apply(enabled) { if (enabled) throw new Error(host.message); return this.status(); } };
  const dataDir = resolve(options.dataDir);
  const scriptPath = join(dataDir, 'start-at-login.ps1');
  const valueName = `Meshrooms-${createHash('sha256').update(dataDir.toLowerCase()).digest('hex').slice(0, 16)}`;
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = `"${powershell}" -NoProfile -NonInteractive -WindowStyle Hidden -File "${scriptPath}"`;
  const script = `$ErrorActionPreference = 'Stop'\n& ${quotePS(options.executable || process.execPath)} run ${quotePS(options.cliPath)} ensure --data-dir ${quotePS(dataDir)} --library ${quotePS(options.libraryPath)} --port ${options.port}\nexit $LASTEXITCODE\n`;
  const reg = (args: string[]) => spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8', timeout: 5000 });
  const status = (): StartupState => {
    const result = reg(['query', key, '/v', valueName]);
    const installed = result.status === 0 && result.stdout.includes(command) && existsSync(scriptPath) && readFileSync(scriptPath, 'utf8') === script;
    return { installed, supported: true, ...(result.status === 0 && !installed ? { message: 'The startup entry needs repair before it can be marked active.' } : {}) };
  };
  return { status, apply(enabled) {
    if (enabled) {
      mkdirSync(dataDir, { recursive: true }); writeFileSync(scriptPath, script, { mode: 0o600 });
      const result = reg(['add', key, '/v', valueName, '/t', 'REG_SZ', '/d', command, '/f']);
      if (result.status !== 0) throw new Error('Windows could not register start at login. Your preference was not saved.');
    } else {
      const present = reg(['query', key, '/v', valueName]);
      if (present.status === 0 && reg(['delete', key, '/v', valueName, '/f']).status !== 0) throw new Error('Windows could not remove the Meshrooms startup entry.');
    }
    const result = status(); if (result.installed !== enabled) throw new Error('The startup preference could not be verified.'); return result;
  } };
}

/** Tests exercise setup without mutating the user's OS startup configuration. */
export function testStartupManager(): StartupManager {
  let installed = false;
  return { status: () => ({ installed, supported: true }), apply(enabled) { installed = enabled; return this.status(); } };
}
