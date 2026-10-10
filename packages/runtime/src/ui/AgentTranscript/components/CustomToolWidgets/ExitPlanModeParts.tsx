/**
 * Pieces of the ExitPlanMode card that are shared between its inline layout and the full-screen
 * review: loading the plan text, rendering it, the full-screen shell, and the answer choices.
 *
 * The widget owns every piece of state (what was answered, the feedback draft); these are
 * presentational so the same choices can sit under the inline plan and under the full-screen one.
 */

import React, { useEffect, useRef, useState } from 'react';
import { MarkdownRenderer } from '../MarkdownRenderer';
import { FullscreenModal } from '../FullscreenModal';

// ============================================================
// Plan text
// ============================================================

export type ExitPlanTextState =
  | { status: 'ready'; text: string }
  | { status: 'loading' }
  | { status: 'unavailable' };

type ReadFile = (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }>;

/** Absolute path of the plan file, or null when a relative one cannot be resolved. */
export function resolvePlanFilePath(planFilePath: string, workspacePath?: string): string | null {
  if (!planFilePath) return null;
  // Absolute on either platform.
  if (planFilePath.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(planFilePath)) return planFilePath;
  if (!workspacePath) return null;
  const separator = workspacePath.includes('\\') ? '\\' : '/';
  return `${workspacePath}${separator}${planFilePath}`;
}

/**
 * The plan's markdown: the tool input's own `plan` text when the agent sent one (the genuine CLI
 * does), otherwise the plan file read through the transcript's `readFile`. The file is only read
 * while `enabled`, so finished cards in a long transcript cost nothing until someone opens them.
 */
export function useExitPlanText(options: {
  inlinePlan: unknown;
  planFilePath: string;
  workspacePath?: string;
  readFile?: ReadFile;
  enabled: boolean;
}): ExitPlanTextState {
  const { inlinePlan, planFilePath, workspacePath, readFile, enabled } = options;
  const inline = typeof inlinePlan === 'string' && inlinePlan.trim() ? inlinePlan : null;
  const absolutePath = resolvePlanFilePath(planFilePath, workspacePath);
  // Callers often pass a fresh function every render; the read must not restart because of that.
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;
  const [loaded, setLoaded] = useState<{ path: string; text: string | null } | null>(null);

  const canRead = !inline && enabled && !!absolutePath && !!readFile;
  const alreadyLoaded = loaded?.path === absolutePath;

  useEffect(() => {
    if (!canRead || alreadyLoaded || !absolutePath) return;
    let cancelled = false;
    const finish = (text: string | null) => {
      if (!cancelled) setLoaded({ path: absolutePath, text });
    };
    readFileRef.current!(absolutePath).then(
      (result) => finish(result.success && result.content?.trim() ? result.content : null),
      () => finish(null),
    );
    return () => {
      cancelled = true;
    };
  }, [canRead, alreadyLoaded, absolutePath]);

  if (inline) return { status: 'ready', text: inline };
  if (!canRead) return { status: 'unavailable' };
  if (alreadyLoaded) return loaded!.text ? { status: 'ready', text: loaded!.text } : { status: 'unavailable' };
  return { status: 'loading' };
}

/** The plan rendered as markdown, or a loading line. Renders nothing when there is no plan text. */
export const ExitPlanBody: React.FC<{ plan: ExitPlanTextState; className?: string; testId?: string }> = ({
  plan,
  className = '',
  testId = 'exit-plan-mode-plan',
}) => {
  if (plan.status === 'loading') {
    return (
      <div data-testid="exit-plan-mode-plan-loading" className="exit-plan-mode-plan-loading px-4 py-3 text-[13px] text-nim-muted">
        Loading plan...
      </div>
    );
  }
  if (plan.status !== 'ready') return null;
  return (
    <div data-testid={testId} className={`exit-plan-mode-plan select-text ${className}`}>
      <MarkdownRenderer content={plan.text} />
    </div>
  );
};

// ============================================================
// Full-screen review
// ============================================================

export const ExitPlanFullscreen: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  plan: ExitPlanTextState;
  planFilePath: string;
  onOpenPlanFile: () => void;
  /** The answer choices (or a note, when the terminal owns the answer). */
  footer: React.ReactNode;
}> = ({ isOpen, onClose, plan, planFilePath, onOpenPlanFile, footer }) => (
  <FullscreenModal isOpen={isOpen} onClose={onClose} ariaLabel="Plan review">
    <div
      data-testid="exit-plan-mode-fullscreen"
      className="exit-plan-mode-fullscreen flex flex-col w-[min(960px,92vw)] h-[88vh] rounded-lg bg-nim-secondary border border-nim shadow-2xl overflow-hidden"
    >
      <div className="exit-plan-mode-fullscreen-header flex items-center gap-3 py-3 px-5 bg-nim-tertiary border-b border-nim shrink-0">
        <span className="text-sm font-semibold text-nim">Plan review</span>
        {planFilePath && (
          <button
            onClick={onOpenPlanFile}
            className="flex-1 min-w-0 truncate text-left text-nim-link hover:text-nim-link-hover hover:underline cursor-pointer bg-transparent border-none p-0 font-mono text-[12px]"
          >
            {planFilePath}
          </button>
        )}
        <button
          data-testid="exit-plan-mode-fullscreen-close"
          onClick={onClose}
          className="ml-auto px-3 py-1 rounded-md text-[12px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-tertiary text-nim-muted"
        >
          Close (Esc)
        </button>
      </div>
      <div className="exit-plan-mode-fullscreen-body flex-1 min-h-0 overflow-y-auto px-8 py-6">
        <ExitPlanBody plan={plan} testId="exit-plan-mode-fullscreen-plan" />
        {plan.status === 'unavailable' && (
          <div className="text-[13px] text-nim-muted">The plan text is not available here. Open the plan file above to read it.</div>
        )}
      </div>
      <div className="exit-plan-mode-fullscreen-footer shrink-0 max-h-[50%] overflow-y-auto border-t border-nim p-4">{footer}</div>
    </div>
  </FullscreenModal>
);

// ============================================================
// Choices
// ============================================================

/**
 * - `sdk`: the Agent SDK's four actions.
 * - `cli`: the CLI card behind an ask project's hook: proceed, or keep planning.
 * - `cli-manual`: the CLI card driving the dialog by keystroke: bypass, manual edits, keep planning.
 */
export type ExitPlanChoiceVariant = 'sdk' | 'cli' | 'cli-manual';

const CHOICE_BUTTON =
  'w-full px-4 py-2 rounded-md text-[13px] font-medium cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover active:opacity-80 bg-nim-tertiary text-nim text-left disabled:opacity-50 disabled:cursor-not-allowed';

export interface ExitPlanChoicesProps {
  variant: ExitPlanChoiceVariant;
  isSubmitting: boolean;
  submitError: string | null;
  showFeedbackInput: boolean;
  feedback: string;
  onFeedbackChange: (value: string) => void;
  onShowFeedback: () => void;
  onCancelFeedback: () => void;
  onSubmitFeedback: () => void;
  onApprove: () => void;
  onApproveManual: () => void;
  onStartNewSession: () => void;
  onCancel: () => void;
}

export const ExitPlanChoices: React.FC<ExitPlanChoicesProps> = (props) => {
  const { variant, isSubmitting, showFeedbackInput, feedback } = props;
  const feedbackInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (showFeedbackInput) feedbackInputRef.current?.focus();
  }, [showFeedbackInput]);

  const handleFeedbackKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      props.onSubmitFeedback();
    } else if (e.key === 'Escape') {
      // Closes the draft only; without this the full-screen view would close with it.
      e.stopPropagation();
      props.onCancelFeedback();
    }
  };

  const numbered = (n: number) => <span className="text-nim-muted mr-2">{n}.</span>;
  const approveNumber = variant === 'sdk' ? 2 : 1;
  const denyNumber = variant === 'cli' ? 2 : 3;

  return (
    <div className="exit-plan-mode-choices">
      <div className="mb-3 text-[13px] text-nim">Would you like to proceed?</div>
      {props.submitError && (
        <div data-testid="exit-plan-mode-error" className="mb-3 text-[13px] text-nim-warning">
          {props.submitError}
        </div>
      )}
      <div className="flex flex-col gap-2">
        {variant === 'sdk' && (
          <button
            data-testid="exit-plan-mode-new-session"
            className={CHOICE_BUTTON}
            onClick={props.onStartNewSession}
            disabled={isSubmitting}
          >
            {numbered(1)}
            Yes, start new session and implement (clean context window)
          </button>
        )}
        <button
          data-testid="exit-plan-mode-approve"
          className={CHOICE_BUTTON}
          onClick={props.onApprove}
          disabled={isSubmitting}
        >
          {numbered(approveNumber)}
          {variant === 'cli-manual' ? 'Approve, continue in bypass' : 'Yes, proceed in this same session'}
        </button>
        {variant === 'cli-manual' && (
          <button
            data-testid="exit-plan-mode-approve-manual"
            className={CHOICE_BUTTON}
            onClick={props.onApproveManual}
            disabled={isSubmitting}
          >
            {numbered(2)}
            Approve, ask before each edit
          </button>
        )}
        {!showFeedbackInput ? (
          <button
            data-testid="exit-plan-mode-deny"
            className={CHOICE_BUTTON}
            onClick={props.onShowFeedback}
            disabled={isSubmitting}
          >
            {numbered(denyNumber)}
            {variant === 'cli-manual' ? 'Keep planning, tell Claude what to change' : 'Type here to tell Claude what to change'}
          </button>
        ) : (
          <div className="flex flex-col gap-2">
            <textarea
              ref={feedbackInputRef}
              data-testid="exit-plan-mode-feedback-input"
              value={feedback}
              onChange={(e) => props.onFeedbackChange(e.target.value)}
              onKeyDown={handleFeedbackKeyDown}
              placeholder="Tell Claude what to change in the plan..."
              className="w-full px-3 py-2 rounded-md text-[13px] border border-nim bg-nim-tertiary text-nim placeholder:text-nim-muted resize-none focus:outline-none focus:border-nim-focus"
              rows={3}
              disabled={isSubmitting}
            />
            <div className="flex gap-2 justify-end">
              <button
                className="px-3 py-1 rounded-md text-[12px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-tertiary text-nim-muted disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={props.onCancelFeedback}
                disabled={isSubmitting}
              >
                Cancel
              </button>
              <button
                data-testid="exit-plan-mode-send-feedback"
                className="px-3 py-1 rounded-md text-[12px] cursor-pointer border-none transition-colors duration-150 hover:opacity-90 bg-nim-primary text-nim-on-primary disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={props.onSubmitFeedback}
                disabled={!feedback.trim() || isSubmitting}
              >
                Send Feedback
              </button>
            </div>
          </div>
        )}
        {variant === 'sdk' && (
          <button
            data-testid="exit-plan-mode-cancel"
            className={CHOICE_BUTTON}
            onClick={props.onCancel}
            disabled={isSubmitting}
          >
            {numbered(4)}
            Stop for now
          </button>
        )}
      </div>
    </div>
  );
};
