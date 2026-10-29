import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A second Nimbalyst instance (launched while one runs) used to write this file over the running instance's and then
// delete it when it quit three seconds later, so out-of-process tools lost the endpoint until the next restart
// (seen 2026-10-28 23:04). Only the lock holder writes, and a process removes the file only when the file is its own.
let dir = '';
let hasLock = true;
vi.mock('electron', () => ({
  app: { getPath: () => dir, hasSingleInstanceLock: () => hasLock },
}));
vi.mock('../../utils/logger', () => ({ logger: { mcp: { info: () => {}, error: () => {} } } }));

import { writeMcpEndpointDescriptor, removeMcpEndpointDescriptor } from '../mcpEndpointDescriptor';

const file = () => path.join(dir, 'mcp-endpoint.json');

describe('mcp endpoint descriptor', () => {
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nim-desc-'));
    hasLock = true;
    delete process.env.NIMBALYST_USER_DATA_DIR;
    delete process.env.PLAYWRIGHT;
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the lock holder writes the descriptor with its own pid', () => {
    writeMcpEndpointDescriptor({ port: 4000, token: 't' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).pid).toBe(process.pid);
  });

  it('a second instance without the lock does not overwrite the running one', () => {
    fs.writeFileSync(file(), JSON.stringify({ pid: 999999, port: 1, token: 'first' }));
    hasLock = false;
    writeMcpEndpointDescriptor({ port: 4000, token: 'second' });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).token).toBe('first');
  });

  it('a multi-instance dev or test run still writes without the lock', () => {
    hasLock = false;
    process.env.NIMBALYST_USER_DATA_DIR = dir;
    writeMcpEndpointDescriptor({ port: 4000, token: 't' });
    expect(fs.existsSync(file())).toBe(true);
  });

  it('quitting removes the descriptor only when it is this process own', () => {
    fs.writeFileSync(file(), JSON.stringify({ pid: 999999, port: 1, token: 'other' }));
    removeMcpEndpointDescriptor();
    expect(fs.existsSync(file())).toBe(true);
    writeMcpEndpointDescriptor({ port: 4000, token: 'mine' });
    removeMcpEndpointDescriptor();
    expect(fs.existsSync(file())).toBe(false);
  });
});
