// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { KimiCliMcpConfigService } from '../kimiCliMcpConfig';

const roots: string[] = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true }); });

function makeService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-cli-mcp-'));
  roots.push(root);
  const kimiHome = path.join(root, '.kimi-code');
  const service = new KimiCliMcpConfigService({
    kimiHome,
    tempDir: path.join(root, 'tmp'),
    launcher: () => ({ command: 'C:\\nodejs\\node.exe', args: ['C:\\app\\resources\\kimiCliMcpLauncher.cjs'] }),
    toSpawnable: (command, args) => (command === 'npx.cmd'
      ? { command: 'C:\\nodejs\\node.exe', args: ['C:\\nodejs\\npx-cli.js', ...args] }
      : { command, args }),
  });
  const homeFile = path.join(kimiHome, 'mcp.json');
  const readHome = () => JSON.parse(fs.readFileSync(homeFile, 'utf8'));
  return { service, kimiHome, homeFile, readHome };
}

const HOST = {
  type: 'sse',
  url: 'http://127.0.0.1:4100/mcp/host?workspacePath=C%3A%5Cwork&sessionId=s1',
  headers: { Authorization: 'Bearer app-token-secret' },
};
const CORE = { ...HOST, url: HOST.url.replace('/mcp/host', '/mcp/core'), timeout: 604800000 };
const BRANDING = { type: 'stdio', command: 'npx.cmd', args: ['-y', 'branding-mcp'], env: { API_KEY: 'user-secret' } };

describe('KimiCliMcpConfigService', () => {
  it('names the session servers in kimi\'s file with no address or secret, and keeps the real ones in a private file', async () => {
    const { service, kimiHome, homeFile, readHome } = makeService();
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(homeFile, JSON.stringify({ note: 'mine', mcpServers: { mine: { command: 'my-own-server' } } }));

    const prepared = await service.prepare('s1', { nimbalyst: CORE, 'nimbalyst-host': HOST, branding: BRANDING });

    const home = readHome();
    expect(home.note).toBe('mine');
    expect(home.mcpServers.mine).toEqual({ command: 'my-own-server' });
    expect(home.mcpServers['nimbalyst-host']).toEqual({
      command: 'C:\\nodejs\\node.exe',
      args: ['C:\\app\\resources\\kimiCliMcpLauncher.cjs', 'nimbalyst-host'],
    });
    // The core server holds the questions that wait on a person; kimi gives up after 60s otherwise.
    expect(home.mcpServers.nimbalyst.toolTimeoutMs).toBe(604800000);
    expect(fs.readFileSync(homeFile, 'utf8')).not.toMatch(/secret|127\.0\.0\.1|sessionId/);

    const session = JSON.parse(fs.readFileSync(prepared!.env.NIMBALYST_KIMI_MCP_CONFIG, 'utf8'));
    expect(session.mcpServers['nimbalyst-host']).toEqual(HOST);
    // kimi and the launcher start servers without a shell, which cannot run a .cmd.
    expect(session.mcpServers.branding).toMatchObject({
      command: 'C:\\nodejs\\node.exe',
      args: ['C:\\nodejs\\npx-cli.js', '-y', 'branding-mcp'],
      env: { API_KEY: 'user-secret' },
    });
  });

  it('never replaces a server the user defined in kimi under the same name', async () => {
    const { service, kimiHome, homeFile, readHome } = makeService();
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(homeFile, JSON.stringify({ mcpServers: { branding: { command: 'their-branding' } } }));

    const prepared = await service.prepare('s1', { branding: BRANDING, 'nimbalyst-host': HOST });

    expect(readHome().mcpServers.branding).toEqual({ command: 'their-branding' });
    expect(prepared!.skipped).toEqual(['branding']);
  });

  it('keeps the names a live session still needs and removes only its own when the last one ends', async () => {
    const { service, kimiHome, homeFile, readHome } = makeService();
    // A second Nimbalyst (a dev build beside the installed one) has a kimi
    // session of its own running; its entry is not this process's to remove.
    const theirs = { command: 'C:\\dev\\node.exe', args: ['C:\\dev\\resources\\kimiCliMcpLauncher.cjs', 'their-server'] };
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(homeFile, JSON.stringify({ mcpServers: { 'their-server': theirs } }));

    await service.prepare('s1', { 'nimbalyst-host': HOST, branding: BRANDING });
    await service.prepare('s2', { 'nimbalyst-host': HOST });
    expect(Object.keys(readHome().mcpServers).sort()).toEqual(['branding', 'nimbalyst-host', 'their-server']);

    await service.release('s1');
    expect(Object.keys(readHome().mcpServers).sort()).toEqual(['nimbalyst-host', 'their-server']);

    await service.release('s2');
    expect(readHome().mcpServers).toEqual({ 'their-server': theirs });
  });

  it('leaves a kimi file it cannot read exactly as it is and gives the session no servers', async () => {
    const { service, kimiHome, homeFile } = makeService();
    fs.mkdirSync(kimiHome, { recursive: true });
    fs.writeFileSync(homeFile, '{ not json');

    expect(await service.prepare('s1', { 'nimbalyst-host': HOST })).toBeNull();
    expect(fs.readFileSync(homeFile, 'utf8')).toBe('{ not json');
  });
});
