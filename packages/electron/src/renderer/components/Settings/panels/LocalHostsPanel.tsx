/**
 * Settings > Local hosts (#416): connect this desktop to a headless
 * `nimbalyst-node serve --transport local` on this machine or the tailnet.
 *
 * Its sessions then show in the session list like any remote session, stream,
 * and take prompts, with no cloud room in between. The panel only talks to the
 * `local-host:*` handlers; saving tests the address and token first.
 */

import type { JSX } from 'react';
import { useCallback, useEffect, useState } from 'react';

interface LocalHostStatus {
  configured: boolean;
  url?: string;
  savedAt?: string;
  online: boolean;
  hostName?: string;
  hostDeviceId?: string;
  sessionCount?: number;
  error?: string;
}

const sectionClass = 'local-hosts-section py-4 border-b border-[var(--nim-border)] last:border-b-0';
const headingClass = 'text-[13px] font-semibold text-[var(--nim-text)] mb-1';
const hintClass = 'text-[12px] leading-relaxed text-[var(--nim-text-muted)]';
const inputClass = 'w-full px-2.5 py-1.5 text-[13px] bg-[var(--nim-bg)] border border-[var(--nim-border)] rounded-md text-[var(--nim-text)] outline-none focus:border-[var(--nim-primary)]';
const buttonClass =
  'px-3 py-1.5 text-[13px] rounded-md border border-[var(--nim-border)] bg-[var(--nim-bg)] text-[var(--nim-text)] hover:border-[var(--nim-primary)] disabled:opacity-50 disabled:cursor-not-allowed transition-colors';

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Electron prefixes handler errors with the channel; the reason is what matters.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function LocalHostsPanel(): JSX.Element {
  const [status, setStatus] = useState<LocalHostStatus | null>(null);
  const [url, setUrl] = useState('http://127.0.0.1:47615');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<'none' | 'testing' | 'saving' | 'removing'>('none');
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await window.electronAPI.invoke('local-host:status'));
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  const test = async () => {
    setBusy('testing');
    setMessage(null);
    try {
      const result = await window.electronAPI.invoke('local-host:test', url, token);
      setMessage(result.ok
        ? { kind: 'ok', text: `Reached ${result.hostName ?? 'the node'}: ${result.sessionCount ?? 0} session(s).` }
        : { kind: 'error', text: result.error ?? 'The node could not be reached.' });
    } finally {
      setBusy('none');
    }
  };

  const save = async () => {
    setBusy('saving');
    setMessage(null);
    try {
      setStatus(await window.electronAPI.invoke('local-host:save', url, token));
      setToken('');
      setMessage({ kind: 'ok', text: 'Saved. Its sessions appear in each project they belong to.' });
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    } finally {
      setBusy('none');
    }
  };

  const remove = async () => {
    setBusy('removing');
    setMessage(null);
    try {
      setStatus(await window.electronAPI.invoke('local-host:remove'));
      setMessage({ kind: 'ok', text: 'Removed. Its sessions are no longer listed; nothing on the node was deleted.' });
    } catch (error) {
      setMessage({ kind: 'error', text: errorText(error) });
    } finally {
      setBusy('none');
    }
  };

  return (
    <div className="local-hosts-panel provider-panel flex flex-col" data-testid="local-hosts-panel">
      <div className="provider-panel-header mb-2 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-1.5 text-[var(--nim-text)]">Local hosts</h3>
        <p className="provider-panel-description text-[13px] leading-relaxed text-[var(--nim-text-muted)]">
          Connect to a headless Nimbalyst node on this machine or your tailnet. Its sessions show in your session list,
          stream live and take prompts, without going through the cloud. The node keeps running when this app is closed.
        </p>
      </div>

      <section className={sectionClass} data-testid="local-hosts-status">
        <h4 className={headingClass}>Connected host</h4>
        {!status ? (
          <p className={hintClass}>Checking...</p>
        ) : status.configured ? (
          <div className="flex items-start justify-between gap-3 select-text">
            <div>
              <p className="text-[13px] text-[var(--nim-text)]">
                {status.hostName ?? 'Node'} at {status.url}
              </p>
              <p className={status.online ? 'text-[12px] text-[var(--nim-success)]' : 'text-[12px] text-[var(--nim-warning)]'}>
                {status.online
                  ? `Online${status.sessionCount !== undefined ? `, ${status.sessionCount} session(s)` : ''}`
                  : 'Offline. The desktop reconnects by itself when the node is back.'}
              </p>
              {status.error ? <p className="text-[12px] text-[var(--nim-error)]">{status.error}</p> : null}
            </div>
            <button type="button" className={buttonClass} disabled={busy !== 'none'} onClick={() => void remove()}>
              {busy === 'removing' ? 'Removing...' : 'Remove'}
            </button>
          </div>
        ) : (
          <p className={hintClass}>No local host yet.{status.error ? ` ${status.error}` : ''}</p>
        )}
      </section>

      <section className={sectionClass} data-testid="local-hosts-form">
        <h4 className={headingClass}>{status?.configured ? 'Replace the host' : 'Add a host'}</h4>
        <p className={`${hintClass} mb-3`}>
          Start the node with <code className="select-text">nimbalyst-node serve --config &lt;file&gt; --transport local</code>,
          then paste its address and the contents of its token file. Only 127.0.0.1 and tailnet addresses are accepted.
        </p>
        <label className="flex flex-col gap-1 mb-2 text-[12px] text-[var(--nim-text-muted)]">
          Address
          <input className={inputClass} value={url} onChange={(event) => setUrl(event.target.value)} spellCheck={false} aria-label="Local host address" />
        </label>
        <label className="flex flex-col gap-1 mb-3 text-[12px] text-[var(--nim-text-muted)]">
          Token
          <input className={inputClass} type="password" value={token} onChange={(event) => setToken(event.target.value)} spellCheck={false} autoComplete="off" aria-label="Local host token" />
        </label>
        <div className="flex items-center gap-2">
          <button type="button" className={buttonClass} disabled={busy !== 'none' || !token} onClick={() => void test()}>
            {busy === 'testing' ? 'Testing...' : 'Test'}
          </button>
          <button type="button" className={buttonClass} disabled={busy !== 'none' || !token} onClick={() => void save()}>
            {busy === 'saving' ? 'Saving...' : 'Save'}
          </button>
        </div>
        {message ? (
          <p className={message.kind === 'ok' ? 'text-[12px] text-[var(--nim-success)] mt-2' : 'text-[12px] text-[var(--nim-error)] mt-2'} role={message.kind === 'error' ? 'alert' : 'status'}>
            {message.text}
          </p>
        ) : null}
      </section>
    </div>
  );
}
