import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

test('installer rejects corrupted, unsafe, incomplete, and conflicting releases before activation', () => {
  // PowerShell 7's module search path is incompatible with Windows PowerShell 5.1.
  const env = { ...process.env, PSModulePath: join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/Modules') };
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dir, 'test-installer.ps1')], { env, encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(result.stdout).toContain('9 passed');
}, 35_000);
