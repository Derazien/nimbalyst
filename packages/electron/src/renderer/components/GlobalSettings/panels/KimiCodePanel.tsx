import React, { useState, useEffect, useCallback } from 'react';
import { ProviderConfig } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';

interface KimiCodePanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
  /** The terminal provider (`kimi-code-cli`), toggled independently. */
  cli?: {
    config: ProviderConfig;
    onToggle: (enabled: boolean) => void;
  };
}

type CLIStatus = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-error';

export function KimiCodePanel({
  config,
  onToggle,
  cli,
}: KimiCodePanelProps) {
  const [cliStatus, setCLIStatus] = useState<CLIStatus>('checking');
  const [cliVersion, setCLIVersion] = useState<string | null>(null);
  const [installError, setInstallError] = useState<string | null>(null);

  const checkCLI = useCallback(async () => {
    setCLIStatus('checking');
    try {
      const result = await window.electronAPI.invoke('cli:checkInstallation', 'kimi');
      if (result?.installed) {
        setCLIVersion(result.version || null);
        setCLIStatus('installed');
      } else {
        setCLIStatus('not-installed');
      }
    } catch {
      setCLIStatus('not-installed');
    }
  }, []);

  useEffect(() => {
    checkCLI();
  }, [checkCLI]);

  const handleInstall = async () => {
    setCLIStatus('installing');
    setInstallError(null);
    try {
      await window.electronAPI.invoke('cli:install', 'kimi', {});
      await checkCLI();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
      setCLIStatus('install-error');
    }
  };

  return (
    <div className="provider-panel kimi-code-panel flex flex-col">
      <div className="provider-panel-header mb-6 pb-4 border-b border-[var(--nim-border)]">
        <h3 className="provider-panel-title text-xl font-semibold leading-tight mb-2 text-[var(--nim-text)] flex items-center gap-2">
          Kimi Code
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h3>
        <p className="provider-panel-description text-sm leading-relaxed text-[var(--nim-text-muted)]">
          Moonshot's Kimi coding agent via the ACP (Agent Communication Protocol) server mode.
          Uses your Kimi membership for authentication — no API key.
        </p>
      </div>

      <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
        <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Kimi CLI</h4>

        {cliStatus === 'checking' && (
          <p className="text-[13px] text-[var(--nim-text-muted)]">Checking for the Kimi CLI...</p>
        )}

        {cliStatus === 'installed' && (
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-[var(--nim-success)] shrink-0" />
            <span className="text-[13px] text-[var(--nim-text)]">
              Installed{cliVersion ? ` (${cliVersion})` : ''}
            </span>
          </div>
        )}

        {(cliStatus === 'not-installed' || cliStatus === 'install-error') && (
          <div>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              The Kimi Code CLI is required to run the agent. Install it with:
            </p>
            <code className="block text-[13px] text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-3 py-2 rounded mb-3 select-text">
              npm install -g @moonshot-ai/kimi-code
            </code>
            <button
              className="inline-flex items-center justify-center py-2 px-4 rounded-md text-sm font-medium cursor-pointer transition-all bg-[var(--nim-primary)] text-white border border-[var(--nim-primary)] hover:opacity-90"
              onClick={handleInstall}
            >
              Install Kimi CLI
            </button>
            {installError && (
              <div className="text-xs mt-2 text-[var(--nim-error)]">
                {installError}
                <p className="mt-1 text-[var(--nim-text-muted)]">
                  Try running manually: <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">npm install -g @moonshot-ai/kimi-code</code>
                </p>
              </div>
            )}
          </div>
        )}

        {cliStatus === 'installing' && (
          <div className="flex items-center gap-2">
            <span className="text-[13px] text-[var(--nim-text-muted)]">Installing Kimi CLI...</span>
          </div>
        )}

        <p className="text-[13px] text-[var(--nim-text-muted)] mt-3 leading-relaxed">
          You can also use the native installer from{' '}
          <a
            href="https://www.kimi.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--nim-primary)] hover:underline"
          >
            kimi.com
          </a>
          {' '}— either way you get the same <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded">kimi</code> command.
        </p>
      </div>

      <SettingsToggle
        variant="enable"
        name="Enable Kimi Code"
        checked={config.enabled || false}
        onChange={onToggle}
      />

      {config.enabled && (
        <>
          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)]">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Authentication</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] mb-3 leading-relaxed">
              Kimi Code uses your Kimi membership. Run{' '}
              <code className="text-[var(--nim-code-text)] bg-[var(--nim-code-bg)] px-1 rounded select-text">kimi login</code>{' '}
              once in a terminal (device-code sign-in); no API key needed.
            </p>
            <p className="text-[13px] text-[var(--nim-text-muted)]">
              Nimbalyst never reads an API key from your environment for this provider.
            </p>
          </div>

          <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
            <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">File tracking</h4>
            <p className="text-[13px] text-[var(--nim-text-muted)] leading-relaxed">
              Kimi Code reports its edits as tool calls. Nimbalyst snapshots each file before
              the edit and watches the project folder live, so diff review and the Files Edited
              list catch even changes written outside an edit tool call.
            </p>
          </div>
        </>
      )}

      {/* Kimi Code CLI -- a separate provider (`kimi-code-cli`) that runs the
          genuine `kimi` binary in a terminal, placed like Claude Code CLI in the
          Claude Agent panel. Off by default: a workflow preference, enabled
          independently of Kimi Code above. */}
      <div className="provider-panel-section py-4 mb-4 mt-2 border-t border-[var(--nim-border)] last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-1 text-[var(--nim-text)] flex items-center gap-2">
          Kimi Code CLI
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h4>
        <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
          For people who prefer working in the <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">kimi</code> command-line tool itself. It runs the genuine CLI in a terminal instead of Kimi Code above: your prompts are typed into it and its replies and tool calls show in the transcript. Approvals happen in kimi&rsquo;s own terminal, and Nimbalyst&rsquo;s built-in tools are not available to it. You don&rsquo;t need this to use your Kimi membership: Kimi Code above already runs on it once you sign in with <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">kimi login</code>.
        </p>

        {cli && (
          <SettingsToggle
            variant="enable"
            name="Enable Kimi Code CLI"
            checked={cli.config.enabled ?? false}
            onChange={(checked) => cli.onToggle(checked)}
          />
        )}
      </div>
    </div>
  );
}
