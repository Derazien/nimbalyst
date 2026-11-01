/**
 * The saved local headless host (#416).
 *
 * Its own private store file, like the sandbox deployment record, so it owns
 * its file outright and does not contend over the shared settings schema. The
 * address is stored as is; the bearer token only ever as `safeStorage`
 * ciphertext, and saving is refused when the OS cannot encrypt, rather than
 * falling back to plain text.
 */

import { safeStorage } from 'electron';
import Store from '../../utils/privateSettingsStore';

export interface LocalHostRecord {
  url: string;
  savedAt: string;
}

interface Persisted extends LocalHostRecord {
  tokenCipher: string;
}

/** The slice of electron-store this needs; tests pass an in-memory one. */
export interface LocalHostBackingStore {
  get(key: 'host'): Persisted | undefined;
  set(key: 'host', value: Persisted): void;
  delete(key: 'host'): void;
}

export interface LocalHostEncryption {
  available(): boolean;
  /** Returns base64 ciphertext. */
  encrypt(value: string): string;
  /** Takes base64 ciphertext. */
  decrypt(value: string): string;
}

export interface LocalHostStore {
  read(): LocalHostRecord | null;
  readToken(): string | null;
  save(url: string, token: string): LocalHostRecord;
  remove(): void;
}

export function createLocalHostStore(backing: () => LocalHostBackingStore, encryption: LocalHostEncryption): LocalHostStore {
  return {
    read() {
      const saved = backing().get('host');
      return saved ? { url: saved.url, savedAt: saved.savedAt } : null;
    },
    readToken() {
      const saved = backing().get('host');
      if (!saved?.tokenCipher || !encryption.available()) return null;
      try {
        return encryption.decrypt(saved.tokenCipher);
      } catch {
        return null;
      }
    },
    save(url, token) {
      if (!encryption.available()) {
        throw new Error('This system cannot encrypt the token, so it was not saved.');
      }
      const record: Persisted = { url, savedAt: new Date().toISOString(), tokenCipher: encryption.encrypt(token) };
      backing().set('host', record);
      return { url: record.url, savedAt: record.savedAt };
    },
    remove() {
      backing().delete('host');
    },
  };
}

let electronStore: Store<{ host?: Persisted }> | null = null;

/** Lazy: electron-store resolves userData at construction. See MAIN_PROCESS_INIT.md. */
export const localHostStore: LocalHostStore = createLocalHostStore(
  () => (electronStore ??= new Store<{ host?: Persisted }>({ name: 'local-headless-host' })) as unknown as LocalHostBackingStore,
  {
    available: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  },
);
