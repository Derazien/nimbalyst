/**
 * The desktop's remote sessions, from every source at once (#416).
 *
 * One mirror reads the cloud personal-sync room (CollabV3Sync: sandboxes, other
 * desktops, cloud-joined nodes). A second reads a headless node reached
 * directly on this machine or the tailnet (LocalServeClient). Both are plain
 * RemoteSessionMirrors; this class gives every IPC handler a single object with
 * the same methods and sends each call to the mirror that owns the session or
 * the host.
 *
 * Ownership is decided per call, never cached: a mirror owns a session when
 * its own index says the session is hosted remotely, and owns a host when that
 * host is in its own device list. The cloud mirror is the fallback, which keeps
 * every existing caller's behaviour exactly as it was when no local host is
 * configured.
 */

import type { ChatAttachment, SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { DeviceInfo, RemoteTurnOptions, SyncProvider } from '@nimbalyst/runtime/sync/types';

import type { RemoteSessionMirror, RemoteSessionSnapshot } from './RemoteSessionMirror';

export class RemoteSessionMirrorSet {
  constructor(
    private readonly cloud: RemoteSessionMirror,
    private readonly local: RemoteSessionMirror,
  ) {}

  private all(): RemoteSessionMirror[] {
    return [this.cloud, this.local];
  }

  private ownerOf(sessionId: string): RemoteSessionMirror {
    return this.all().find((mirror) => mirror.isRemote(sessionId)) ?? this.cloud;
  }

  /** The cloud provider. Called by SyncManager, unchanged. */
  setProvider(provider: SyncProvider | null, encryptionKey: CryptoKey | null = null): void {
    this.cloud.setProvider(provider, encryptionKey);
  }

  /** The local-host client, or null when no local host is configured. */
  setLocalProvider(provider: SyncProvider | null, encryptionKey: CryptoKey | null = null): void {
    this.local.setProvider(provider, encryptionKey);
  }

  isRemote(sessionId: string): boolean {
    return this.all().some((mirror) => mirror.isRemote(sessionId));
  }

  async assertLocalExecution(sessionId: string): Promise<void> {
    for (const mirror of this.all()) await mirror.assertLocalExecution(sessionId);
  }

  /** Each mirror appends the remote sessions it knows and skips ids already present. */
  async list(workspacePath: string, local: SessionMeta[]): Promise<SessionMeta[]> {
    let merged = local;
    for (const mirror of this.all()) merged = await mirror.list(workspacePath, merged);
    return merged;
  }

  async get(id: string, workspace: string): Promise<SessionData | null> {
    const owner = this.ownerOf(id);
    const owned = await owner.get(id, workspace);
    if (owned) return owned;
    for (const mirror of this.all()) {
      if (mirror === owner) continue;
      const found = await mirror.get(id, workspace);
      if (found) return found;
    }
    return null;
  }

  watch(id: string, workspace: string, listener: (snapshot: RemoteSessionSnapshot) => void): Promise<() => void> {
    return this.ownerOf(id).watch(id, workspace, listener);
  }

  queue(id: string, workspace: string, prompt: string, attachments: ChatAttachment[] = [], options?: RemoteTurnOptions): Promise<{ promptId: string }> {
    return this.ownerOf(id).queue(id, workspace, prompt, attachments, options);
  }

  cancel(id: string, workspace: string): Promise<void> {
    return this.ownerOf(id).cancel(id, workspace);
  }

  workspaceContext(id: string, workspace: string): Promise<unknown> {
    return this.ownerOf(id).workspaceContext(id, workspace);
  }

  /** Every mirror's hosts, the first mirror to list a device winning a duplicate. */
  async hosts(workspace: string): Promise<DeviceInfo[]> {
    const seen = new Set<string>();
    const hosts: DeviceInfo[] = [];
    for (const mirror of this.all()) {
      for (const device of await mirror.hosts(workspace)) {
        if (seen.has(device.deviceId)) continue;
        seen.add(device.deviceId);
        hosts.push(device);
      }
    }
    return hosts;
  }

  /** Sent through the mirror whose own device list holds `host`. */
  async create(workspace: string, host: string, options: Parameters<RemoteSessionMirror['create']>[2] = {}): Promise<string> {
    for (const mirror of [this.local, this.cloud]) {
      if ((await mirror.hosts(workspace)).some((device) => device.deviceId === host)) {
        return mirror.create(workspace, host, options);
      }
    }
    return this.cloud.create(workspace, host, options);
  }
}
