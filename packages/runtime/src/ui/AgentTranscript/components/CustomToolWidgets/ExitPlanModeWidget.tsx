/**
 * ExitPlanModeWidget
 *
 * Custom tool widget that renders when Claude calls ExitPlanMode.
 * Shows the plan file path and allows user to approve/deny the exit from planning mode.
 *
 * Uses InteractiveWidgetHost for operations that require access to atoms, callbacks, and analytics.
 * The host is read from interactiveWidgetHostAtom(sessionId) - no prop drilling needed.
 */

import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import type { CustomToolWidgetProps } from './index';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import {
  ExitPlanBody,
  ExitPlanChoices,
  ExitPlanFullscreen,
  resolvePlanFilePath,
  useExitPlanText,
  type ExitPlanChoiceVariant,
} from './ExitPlanModeParts';

// ============================================================
// Types
// ============================================================

interface ExitPlanModeArgs {
  /** Full plan markdown. The genuine CLI sends it; the Agent SDK sends only the file path. */
  plan?: string;
  planFilePath?: string;
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
}

/**
 * Tool calls whose plan review already opened full screen once. Module-level so a remount (the
 * transcript virtualizes and re-renders cards) does not throw the same plan back in the user's face.
 */
const autoOpenedPlanReviews = new Set<string>();

// ============================================================
// Widget Component
// ============================================================

export const ExitPlanModeWidget: React.FC<CustomToolWidgetProps> = ({
  message,
  workspacePath,
  sessionId,
  readFile,
}) => {
  const toolCall = message.toolCall;
  if (!toolCall) {
    return null;
  }

  // Get host from atom (set by SessionTranscript)
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));

  // Get data from tool call arguments
  const args = toolCall.arguments as ExitPlanModeArgs | undefined;
  const planFilePath = args?.planFilePath || '';

  // Parse the tool result
  const toolResult = toolCall.result ?? '';
  const isCompleted = toolResult !== '';

  // The requestId is the tool call ID
  const requestId = toolCall.providerToolCallId || `exit-plan-${Date.now()}`;

  // Widget is interactive if the tool hasn't completed yet
  const isPending = !isCompleted;

  // Local state for UI
  const [showFeedbackInput, setShowFeedbackInput] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hasResponded, setHasResponded] = useState(false);
  // Why the last answer was refused (e.g. the CLI's own dialog must be answered in the terminal).
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [localResult, setLocalResult] = useState<{
    approved: boolean;
    feedback?: string;
    startNewSession?: boolean;
  } | null>(null);
  const [fullscreenOpen, setFullscreenOpen] = useState(false);
  const [planExpanded, setPlanExpanded] = useState(false);

  // Parse completed state from result
  const completedState = useMemo(() => {
    if (!isCompleted || !toolResult) return null;

    const resultLower = toolResult.toLowerCase();

    // Explicit user denials arrive as error results: a plan-card denial through the CLI hook
    // ("PreToolUse:ExitPlanMode hook error: Plan denied by the user ...") and the CLI's own dialog
    // feedback ("The user doesn't want to proceed with this tool use ..."). They are answers, not failures.
    if (
      resultLower.includes('plan denied by the user') ||
      resultLower.includes("user doesn't want to proceed")
    ) {
      return { type: 'denied' as const };
    }

    // Check for error patterns first - don't show as completed, return null to keep interactive UI
    if (resultLower.includes('error') || resultLower.includes('missing') || resultLower.includes('invalid')) {
      return null;
    }

    // Check for denial patterns
    if (resultLower.includes('denied') || resultLower.includes('continue planning') || resultLower.includes('cancelled')) {
      return { type: 'denied' as const };
    }

    // Check for approval patterns
    // Note: We can't reliably distinguish user-initiated approval from SDK timeout
    // based solely on the tool result text. Both produce similar messages.
    // TODO: To detect timeouts, we'd need to check if there's an exit_plan_mode_response
    // message in the transcript (which we persist when user responds via IPC).
    // For now, treat all approvals the same - the agent proceeded either way.
    if (resultLower.includes('approved') || resultLower.includes('exited planning')) {
      return { type: 'approved' as const };
    }

    // Unknown result - don't default to approved, return null to keep interactive
    return null;
  }, [isCompleted, toolResult]);

  // Determine display result (local takes precedence while waiting for tool to complete)
  const displayResult = localResult || (completedState ? {
    approved: completedState.type === 'approved',
  } : null);

  // The plan to review. A pending card loads it straight away; a finished one only once expanded.
  const isFinished = !!(displayResult || hasResponded);
  const plan = useExitPlanText({
    inlinePlan: args?.plan,
    planFilePath,
    workspacePath,
    readFile,
    enabled: !isFinished || planExpanded,
  });
  const canShowPlan = (typeof args?.plan === 'string' && args.plan.trim() !== '') || (!!planFilePath && !!readFile);

  // Open the full-screen review once per tool call, the first time there is a plan to read and the
  // card is waiting on the user. Closing it (Escape) returns to the inline card for good: remounts
  // find the call already in the set. A plan that never loads never opens an empty modal.
  const autoOpenKey = `${sessionId}:${toolCall?.providerToolCallId ?? `message-${message.id}`}`;
  const awaitingReview = isPending && !isFinished && !!host;
  useEffect(() => {
    if (!awaitingReview || plan.status !== 'ready' || autoOpenedPlanReviews.has(autoOpenKey)) return;
    autoOpenedPlanReviews.add(autoOpenKey);
    setFullscreenOpen(true);
  }, [awaitingReview, plan.status, autoOpenKey]);

  // Handle approve
  const handleApprove = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setLocalResult({ approved: true });
    setHasResponded(true);

    try {
      await host.exitPlanModeApprove(requestId);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to approve:', error);
      setSubmitError(error instanceof Error ? error.message : null);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  // Handle approve while keeping the CLI's per-edit prompts (host offers it only where it differs from approve)
  const handleApproveManual = useCallback(async () => {
    if (hasResponded || !isPending || !host?.exitPlanModeApproveManual) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setLocalResult({ approved: true });
    setHasResponded(true);

    try {
      await host.exitPlanModeApproveManual(requestId);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to approve with manual edits:', error);
      setSubmitError(error instanceof Error ? error.message : null);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  // Handle start new session
  const handleStartNewSession = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    // Match the "Stop for now" end state in the original session while
    // the replacement session opens with the implementation prompt.
    setLocalResult({ approved: false, startNewSession: true });
    setHasResponded(true);

    try {
      await host.exitPlanModeStartNewSession(requestId, planFilePath);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to start new session:', error);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, planFilePath, hasResponded, isPending]);

  // Handle deny with feedback
  const handleDeny = useCallback(async (feedbackText?: string) => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setSubmitError(null);
    setLocalResult({ approved: false, feedback: feedbackText });
    setHasResponded(true);

    try {
      await host.exitPlanModeDeny(requestId, feedbackText);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to deny:', error);
      setSubmitError(error instanceof Error ? error.message : null);
      setLocalResult(null);
      setHasResponded(false);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  // Handle cancel (stop the session)
  const handleCancel = useCallback(async () => {
    if (hasResponded || !isPending || !host) return;

    setIsSubmitting(true);
    setLocalResult({ approved: false });
    setHasResponded(true);

    try {
      await host.exitPlanModeCancel(requestId);
    } catch (error) {
      console.error('[ExitPlanModeWidget] Failed to cancel:', error);
    } finally {
      setIsSubmitting(false);
    }
  }, [host, requestId, hasResponded, isPending]);

  const handleShowFeedbackInput = useCallback(() => {
    setShowFeedbackInput(true);
  }, []);

  const handleSubmitFeedback = useCallback(() => {
    if (feedback.trim()) {
      handleDeny(feedback.trim());
    }
  }, [feedback, handleDeny]);

  const handleCancelFeedback = useCallback(() => {
    setShowFeedbackInput(false);
    setFeedback('');
  }, []);

  const handleOpenPlanFile = useCallback(() => {
    if (!planFilePath || !workspacePath) return;

    // Relative paths resolve against the workspace; absolute ones (either platform) pass through.
    const absolutePath = resolvePlanFilePath(planFilePath, workspacePath);
    if (absolutePath && host) {
      host.openFile(absolutePath);
    }
  }, [planFilePath, workspacePath, host]);

  const closeFullscreen = useCallback(() => setFullscreenOpen(false), []);
  const openFullscreen = useCallback(() => setFullscreenOpen(true), []);

  const planFileLink = planFilePath ? (
    <button
      onClick={handleOpenPlanFile}
      className="text-nim-link hover:text-nim-link-hover hover:underline cursor-pointer bg-transparent border-none p-0 font-mono text-[13px]"
    >
      {planFilePath}
    </button>
  ) : null;

  // Show completed state
  if (isFinished) {
    const approved = displayResult?.approved ?? false;

    return (
      <div
        data-testid="exit-plan-mode-widget"
        data-state={approved ? 'approved' : 'denied'}
        className={`exit-plan-mode-widget rounded-lg border overflow-hidden opacity-85 ${
          approved ? 'bg-nim-secondary border-nim-success' : 'bg-nim-secondary border-nim'
        }`}
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <div className={`w-5 h-5 shrink-0 ${approved ? 'text-nim-success' : 'text-nim-muted'}`}>
            {approved ? (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                <path d="M13 4L6 11L3 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="w-full h-full">
                <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </div>
          <span className="text-sm font-semibold text-nim flex-1">
            {approved ? 'Exited Planning Mode' : 'Continued Planning'}
          </span>
          <span
            data-testid={approved ? 'exit-plan-mode-approved' : 'exit-plan-mode-denied'}
            className={`flex items-center gap-1 text-xs font-medium py-1 px-2 rounded-full ${
              approved ? 'text-nim-success bg-[color-mix(in_srgb,var(--nim-success)_12%,transparent)]' : 'text-nim-muted bg-nim-tertiary'
            }`}
          >
            {approved ? 'Approved' : 'Denied'}
          </span>
        </div>
        {planFilePath && (
          <div className="px-4 py-2 text-[13px] text-nim-muted">
            Plan: {planFileLink}
          </div>
        )}
        {canShowPlan && (
          <div className="exit-plan-mode-finished-plan px-4 pb-3">
            <button
              data-testid="exit-plan-mode-plan-toggle"
              onClick={() => setPlanExpanded((open) => !open)}
              aria-expanded={planExpanded}
              className="text-[13px] text-nim-muted hover:text-nim cursor-pointer bg-transparent border-none p-0"
            >
              {planExpanded ? 'Hide plan' : 'Show plan'}
            </button>
            {planExpanded && (
              <>
                <ExitPlanBody plan={plan} className="mt-2 max-h-[50vh] overflow-y-auto rounded-md border border-nim p-4" />
                {plan.status === 'unavailable' && (
                  <div className="mt-2 text-[13px] text-nim-muted">The plan text is not available here.</div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  // If tool is not pending (has a result) but we didn't handle it above, show nothing
  if (!isPending) {
    return null;
  }

  const reviewButton =
    plan.status === 'ready' ? (
      <button
        data-testid="exit-plan-mode-fullscreen-open"
        onClick={openFullscreen}
        className="exit-plan-mode-fullscreen-open px-3 py-1 rounded-md text-[12px] cursor-pointer border border-nim transition-colors duration-150 hover:bg-nim-hover bg-nim-secondary text-nim"
      >
        Review full screen
      </button>
    ) : null;

  const inlinePlan = (
    <ExitPlanBody plan={plan} className="max-h-[60vh] overflow-y-auto rounded-md border border-nim bg-nim p-4" />
  );

  // The CLI asks for approval in its own terminal dialog; buttons here would no-op.
  if (host?.exitPlanModeInTerminal) {
    return (
      <div
        data-testid="exit-plan-mode-widget"
        data-state="pending-terminal"
        className="exit-plan-mode-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <span className="text-sm font-semibold text-nim flex-1">
            Plan ready for review
          </span>
          <span data-testid="exit-plan-mode-in-terminal" className="text-xs text-nim-muted">
            Approve or keep planning in the terminal below
          </span>
          {reviewButton}
        </div>
        {planFilePath && (
          <div className="px-4 py-2 text-[13px]">
            <span className="text-nim-muted">Plan file: </span>
            {planFileLink}
          </div>
        )}
        {plan.status !== 'unavailable' && <div className="px-4 pb-4">{inlinePlan}</div>}
        <ExitPlanFullscreen
          isOpen={fullscreenOpen}
          onClose={closeFullscreen}
          plan={plan}
          planFilePath={planFilePath}
          onOpenPlanFile={handleOpenPlanFile}
          footer={<div className="text-[13px] text-nim-muted">Approve or keep planning in the terminal below.</div>}
        />
      </div>
    );
  }

  // If no host available, show non-interactive pending state
  if (!host) {
    return (
      <div
        data-testid="exit-plan-mode-widget"
        data-state="pending"
        className="exit-plan-mode-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
      >
        <div className="flex items-center gap-2 py-3 px-4 bg-nim-tertiary">
          <div className="w-5 h-5 text-nim-primary shrink-0">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11z"/>
              <path d="M8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 6a1 1 0 100 2 1 1 0 000-2z"/>
            </svg>
          </div>
          <span className="text-sm font-semibold text-nim flex-1">
            Ready to exit planning mode?
          </span>
          <span data-testid="exit-plan-mode-pending" className="text-xs text-nim-muted">Waiting...</span>
        </div>
        {plan.status !== 'unavailable' && <div className="px-4 py-3">{inlinePlan}</div>}
      </div>
    );
  }

  // Show interactive UI for pending request
  const approveOrReviseOnly = host.exitPlanModeApproveOrReviseOnly === true;
  const choiceVariant: ExitPlanChoiceVariant = !approveOrReviseOnly
    ? 'sdk'
    : host.exitPlanModeApproveManual
      ? 'cli-manual'
      : 'cli';
  const choices = (
    <ExitPlanChoices
      variant={choiceVariant}
      isSubmitting={isSubmitting}
      submitError={submitError}
      showFeedbackInput={showFeedbackInput}
      feedback={feedback}
      onFeedbackChange={setFeedback}
      onShowFeedback={handleShowFeedbackInput}
      onCancelFeedback={handleCancelFeedback}
      onSubmitFeedback={handleSubmitFeedback}
      onApprove={handleApprove}
      onApproveManual={handleApproveManual}
      onStartNewSession={handleStartNewSession}
      onCancel={handleCancel}
    />
  );
  return (
    <div
      data-testid="exit-plan-mode-widget"
      data-state="pending"
      className="exit-plan-mode-widget rounded-lg bg-nim-secondary border border-nim-primary overflow-hidden"
    >
      <div className="flex items-center gap-2 py-3 px-4 border-b border-nim bg-nim-tertiary">
        <div className="w-5 h-5 text-nim-primary shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm0 12.5a5.5 5.5 0 110-11 5.5 5.5 0 010 11z"/>
            <path d="M8 4a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 018 4zm0 6a1 1 0 100 2 1 1 0 000-2z"/>
          </svg>
        </div>
        <span className="text-sm font-semibold text-nim flex-1">
          Ready to exit planning mode?
        </span>
        {reviewButton}
      </div>

      <div className="p-4">
        {planFilePath && (
          <div className="mb-3 p-2 bg-nim-tertiary rounded-md text-[13px]">
            <span className="text-nim-muted">Plan file: </span>
            {planFileLink}
          </div>
        )}
        {plan.status !== 'unavailable' && <div className="mb-4">{inlinePlan}</div>}

        {/* While the full-screen review is open it owns the choices, so each testid exists once. */}
        {!fullscreenOpen && choices}
      </div>

      <ExitPlanFullscreen
        isOpen={fullscreenOpen}
        onClose={closeFullscreen}
        plan={plan}
        planFilePath={planFilePath}
        onOpenPlanFile={handleOpenPlanFile}
        footer={choices}
      />
    </div>
  );
};
