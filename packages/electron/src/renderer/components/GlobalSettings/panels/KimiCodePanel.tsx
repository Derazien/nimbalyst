import React, { useState, useEffect, useCallback } from 'react';
import { ProviderConfig, Model } from '../../Settings/SettingsView';
import { SettingsToggle } from '../SettingsToggle';
import { AlphaBadge, SETTINGS_ALPHA_TOOLTIP } from '../../common/AlphaBadge';

/** Props for the sibling Kimi Code CLI subsection (Phase 0). */
interface KimiCliBundle {
  config: ProviderConfig;
  availableModels: Model[];
  loading: boolean;
  onToggle: (enabled: boolean) => void;
  onModelVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetAllVisible: (visible: boolean) => void;
}

interface KimiCodePanelProps {
  config: ProviderConfig;
  onToggle: (enabled: boolean) => void;
  /** The interactive-CLI provider (`kimi-code-cli`), toggled independently. */
  cli: KimiCliBundle;
}

type CLIStatus = 'checking' | 'installed' | 'not-installed' | 'installing' | 'install-error';

// Same hidden-set model list the Claude panel shows for its CLI sibling:
// rows come from the provider's own catalog, unchecking hides from the picker.
function AvailableModelsSection({
  models,
  hiddenModels,
  loading,
  onVisibilityToggle,
  onSetAllVisible,
}: {
  models: Model[];
  hiddenModels: string[];
  loading: boolean;
  onVisibilityToggle: (modelId: string, visible: boolean) => void;
  onSetAllVisible: (visible: boolean) => void;
}) {
  return (
    <div className="provider-panel-section py-4 mb-4 border-b border-[var(--nim-border)] last:border-b-0 last:mb-0 last:pb-0">
      <h4 className="provider-panel-section-title text-base font-semibold mb-3 text-[var(--nim-text)]">Available models</h4>
      {loading && (
        <div className="models-loading text-sm text-[var(--nim-text-muted)] py-2">Loading models...</div>
      )}
      {!loading && models.length > 0 && (
        <div className="models-section">
          <div className="models-header flex items-center justify-between mb-3">
            <span className="text-sm text-[var(--nim-text-muted)]">Uncheck models to hide them from the picker:</span>
            <div className="models-actions flex gap-2">
              <button
                className="models-action-btn text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetAllVisible(true)}
              >
                Show all
              </button>
              <button
                className="models-action-btn text-xs py-1 px-2 rounded bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)] cursor-pointer transition-all"
                onClick={() => onSetAllVisible(false)}
              >
                Hide all
              </button>
            </div>
          </div>
          <div className="models-grid flex flex-col gap-2">
            {models.map(model => (
              <label key={model.id} className="model-checkbox flex items-center gap-3 py-2 px-3 rounded-md bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] cursor-pointer hover:bg-[var(--nim-bg-hover)]">
                <input
                  type="checkbox"
                  checked={!hiddenModels.includes(model.id)}
                  onChange={(e) => onVisibilityToggle(model.id, e.target.checked)}
                  className="w-4 h-4 cursor-pointer accent-[var(--nim-primary)]"
                />
                <span className="text-sm text-[var(--nim-text)]">{model.name}</span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-[var(--nim-text-faint)] leading-relaxed mt-3">
            Unchecked models are hidden from the session model picker. New models appear automatically.
          </p>
        </div>
      )}
      {!loading && models.length === 0 && (
        <div className="models-loading text-sm text-[var(--nim-text-muted)] py-2">No models available.</div>
      )}
    </div>
  );
}

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

      {/* Kimi Code CLI — a separate provider (`kimi-code-cli`) that runs the
          genuine `kimi` binary in a terminal. Phase 0: identity and model
          catalog only. Off by default, trimmed independently of the agent above. */}
      <div className="provider-panel-section py-4 mb-4 mt-2 border-t border-[var(--nim-border)] last:mb-0 last:pb-0">
        <h4 className="provider-panel-section-title text-base font-semibold mb-1 text-[var(--nim-text)] flex items-center gap-2">
          Kimi Code CLI
          <AlphaBadge size="sm" tooltip={SETTINGS_ALPHA_TOOLTIP} />
        </h4>
        <p className="text-xs leading-relaxed text-[var(--nim-text-muted)] mb-3">
          For people who prefer working in the <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">kimi</code> command-line tool itself. Phase 0: the provider is registered and its models appear in the picker, but interactive terminal sessions are coming soon. You don&rsquo;t need this to use your Kimi membership: Kimi Code above already runs on it once you sign in with <code className="text-xs bg-[var(--nim-bg-tertiary)] px-1 py-0.5 rounded">kimi login</code>.
        </p>

        <SettingsToggle
          variant="enable"
          name="Enable Kimi Code CLI"
          checked={cli.config.enabled ?? false}
          onChange={(checked) => cli.onToggle(checked)}
        />

        {(cli.config.enabled ?? false) && (
          <AvailableModelsSection
            models={cli.availableModels}
            hiddenModels={cli.config.hiddenModels || []}
            loading={cli.loading}
            onVisibilityToggle={cli.onModelVisibilityToggle}
            onSetAllVisible={cli.onSetAllVisible}
          />
        )}
      </div>
    </div>
  );
}
