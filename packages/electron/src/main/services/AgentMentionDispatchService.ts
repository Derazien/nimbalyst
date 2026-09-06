import { isAvailableAgentDelivery, conversationIdForDelivery, messageIdForDelivery, policyKeyForDelivery } from './inboxAgentDeliveryIdentity';
import {
  feedbackRequestUrn,
  type ConversationEvent,
} from '@nimbalyst/collab-protocol';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { TeamInboxMaterializedDelivery, TeamInboxSnapshot } from '@nimbalyst/runtime/sync';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';

import { getQueuedPromptsStore } from './RepositoryManager';
import type { QueuedPromptsStore } from './PGLiteQueuedPromptsStore';
import { getConversationService } from './ConversationService';
import { getTeamInboxService, type TeamInboxService } from './TeamInboxService';
import type { AIService } from './ai/AIService';
import { subscribeQueuedPromptClaims } from './ai/queuedPromptClaimEvents';
import { logger } from '../utils/logger';
import { buildConversationDeepLink } from '../../shared/conversationDeepLinks';
import { getFeedbackRequestService } from './FeedbackRequestService';
import { registerFeedbackRequestWakePolicy } from './FeedbackRequestWakePolicy';
import type { FeedbackRequestServiceState } from '../../shared/feedbackRequest';
import { documentDecisionWakePolicy, documentDecisionWakePrompt } from './documentDecisionWake';

const DEFAULT_BATCH_DELAY_MS = 40;
const CLAIM_LEASE_RETRY_MS = 61_000;

export interface AgentWakeCandidate {
  deliveryId: string;
  orgId: string;
  conversationId: string;
  messageId: string;
  sessionId: string;
  createdAt: number;
  snippet?: string;
  policyMetadata?: Record<string, unknown>;
  resourceKind?: string;
  resourceId?: string;
}

export interface AgentWakePolicyContext {
  policyKey: string;
  sessionId: string;
  conversationId: string;
  candidates: readonly AgentWakeCandidate[];
}

export interface AgentWakePolicyDecision {
  wake: boolean;
  reason: string;
}

export type AgentWakePolicy = (
  context: AgentWakePolicyContext,
) => AgentWakePolicyDecision | Promise<AgentWakePolicyDecision>;

export class AgentWakePolicyRegistry {
  private readonly policies = new Map<string, AgentWakePolicy>();

  constructor() {
    this.register('documentDecision', documentDecisionWakePolicy);
    this.register('agentMention', () => ({
      wake: true,
      reason: 'explicit agent mention',
    }));
  }

  register(policyKey: string, policy: AgentWakePolicy): () => void {
    this.policies.set(policyKey, policy);
    return () => {
      if (this.policies.get(policyKey) === policy) this.policies.delete(policyKey);
    };
  }

  evaluate(context: AgentWakePolicyContext): Promise<AgentWakePolicyDecision> {
    const policy = this.policies.get(context.policyKey);
    return Promise.resolve(
      policy?.(context) ?? {
        wake: false,
        reason: `no wake policy registered for ${context.policyKey}`,
      },
    );
  }
}

interface DispatchInbox {
  start(): Promise<TeamInboxSnapshot>;
  getSnapshot(): TeamInboxSnapshot;
  subscribe(listener: (snapshot: TeamInboxSnapshot) => void): () => void;
  claimAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
  completeAgentDelivery(deliveryId: string, sessionId: string): Promise<boolean>;
}

interface DispatchDependencies {
  inbox: DispatchInbox;
  queueStore: QueuedPromptsStore;
  getSession(sessionId: string): ReturnType<typeof AISessionsRepository.get>;
  queuePrompt(
    sessionId: string,
    prompt: string,
    documentContext: Record<string, unknown>,
  ): Promise<{ id: string }>;
  requestDrive(sessionId: string, workspacePath: string): void;
  subscribePromptClaims(listener: (event: { sessionId: string; promptId: string }) => void): () => void;
  subscribeSessionState(listener: (event: { type: string; sessionId: string }) => void): () => void;
  loadConversationEvents(orgId: string, conversationId: string): Promise<ConversationEvent[]>;
  loadFeedbackRequestState?(
    workspacePath: string,
    orgId: string,
    requestId: string,
  ): Promise<FeedbackRequestServiceState>;
  policies?: AgentWakePolicyRegistry;
  batchDelayMs?: number;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  logInfo?: (message: string) => void;
  logWarn?: (message: string, error?: unknown) => void;
  logError?: (message: string, error: unknown) => void;
}

interface PendingGroup {
  key: string;
  policyKey: string;
  sessionId: string;
  conversationId: string;
  orgId: string;
  candidates: AgentWakeCandidate[];
}

function groupKey(sessionId: string, orgId: string, conversationId: string): string {
  return JSON.stringify([sessionId, orgId, conversationId]);
}

function messageLink(orgId: string, conversationId: string, messageId: string): string {
  return buildConversationDeepLink(orgId, conversationId, messageId);
}

function eventText(event: ConversationEvent): string | null {
  if (event.operation !== 'messageCreated') return null;
  const text = event.payload?.body?.text?.trim();
  if (!text) return null;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

export class AgentMentionDispatchService {
  readonly policies: AgentWakePolicyRegistry;

  private readonly dependencies: DispatchDependencies;
  private readonly activeKeys = new Map<string, string>();
  private cleanup: Array<() => void> = [];
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private leaseRetryScheduled: ReturnType<typeof setTimeout> | null = null;
  private scanning = false;
  private rescanRequested = false;
  private started = false;

  constructor(dependencies: DispatchDependencies) {
    this.dependencies = dependencies;
    this.policies = dependencies.policies ?? new AgentWakePolicyRegistry();
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.cleanup.push(this.dependencies.inbox.subscribe(() => this.scheduleScan()));
    this.cleanup.push(this.dependencies.subscribePromptClaims((event) => {
      void this.handlePromptClaimed(event.promptId).catch((error) => {
        this.logError('[AgentMentionDispatch] Failed to acknowledge a claimed prompt:', error);
      });
    }));
    this.cleanup.push(this.dependencies.subscribeSessionState((event) => {
      if (
        event.type !== 'session:completed'
        && event.type !== 'session:error'
        && event.type !== 'session:interrupted'
      ) {
        return;
      }
      for (const key of [...this.activeKeys.keys()]) {
        if (JSON.parse(key)[0] === event.sessionId) this.activeKeys.delete(key);
      }
      this.scheduleScan();
    }));
    await this.dependencies.inbox.start();
    this.scheduleScan();
  }

  destroy(): void {
    this.started = false;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    if (this.scheduled) this.clearTimer(this.scheduled);
    if (this.leaseRetryScheduled) this.clearTimer(this.leaseRetryScheduled);
    this.scheduled = null;
    this.leaseRetryScheduled = null;
    this.activeKeys.clear();
  }

  private scheduleScan(): void {
    if (!this.started || this.scheduled) return;
    this.scheduled = this.setTimer(() => {
      this.scheduled = null;
      void this.scan().catch((error) => {
        this.logError('[AgentMentionDispatch] Dispatch scan failed:', error);
      });
    }, this.dependencies.batchDelayMs ?? DEFAULT_BATCH_DELAY_MS);
  }

  private async scan(): Promise<void> {
    if (this.scanning) {
      this.rescanRequested = true;
      return;
    }
    this.scanning = true;
    try {
      const snapshot = this.dependencies.inbox.getSnapshot();
      if (snapshot.status !== 'ready') return;
      const groups = this.pendingGroups(snapshot);
      for (const group of groups) await this.dispatchGroup(group);
    } finally {
      this.scanning = false;
      if (this.rescanRequested) {
        this.rescanRequested = false;
        this.scheduleScan();
      }
    }
  }

  private pendingGroups(snapshot: TeamInboxSnapshot): PendingGroup[] {
    const groups = new Map<string, PendingGroup>();
    for (const delivery of snapshot.deliveries) {
      if (!isAvailableAgentDelivery(delivery)) continue;
      const policyKey = policyKeyForDelivery(delivery);
      const conversationId = conversationIdForDelivery(delivery);
      const messageId = messageIdForDelivery(delivery);
      if (!policyKey || !conversationId || !messageId) continue;
      const dispatched = new Set(delivery.agentDispatchedSessionIds ?? []);
      for (const sessionId of delivery.agentSessionIds) {
        if (dispatched.has(sessionId)) continue;
        const key = groupKey(sessionId, delivery.orgId, conversationId);
        const policyGroupKey = JSON.stringify([key, policyKey]);
        const group = groups.get(policyGroupKey) ?? {
          key,
          policyKey,
          sessionId,
          conversationId,
          orgId: delivery.orgId,
          candidates: [],
        };
        group.candidates.push({
          deliveryId: delivery.id,
          orgId: delivery.orgId,
          conversationId,
          messageId,
          sessionId,
          createdAt: delivery.createdAt,
          snippet: delivery.preview?.snippet,
          policyMetadata: delivery.agentWakeMetadata,
          ...('resourceKind' in delivery.source
            ? {
                resourceKind: delivery.source.resourceKind,
                resourceId: delivery.source.resourceId,
              }
            : {}),
        });
        groups.set(policyGroupKey, group);
      }
    }
    return [...groups.values()].sort((left, right) =>
      Math.min(...left.candidates.map((candidate) => candidate.createdAt))
      - Math.min(...right.candidates.map((candidate) => candidate.createdAt)));
  }

  private async dispatchGroup(group: PendingGroup): Promise<void> {
    if (this.activeKeys.has(group.key)) return;
    const session = await this.dependencies.getSession(group.sessionId);
    if (!session?.workspacePath) {
      this.logWarn(
        `[AgentMentionDispatch] Refusing delivery for unavailable local session ${group.sessionId}`,
      );
      return;
    }

    const existing = (await this.dependencies.queueStore.listForSession(
      group.sessionId,
      { includeCompleted: true },
    )).filter((prompt) => {
      const origin = prompt.documentContext?.agentWakeOrigin;
      return origin
        && groupKey(prompt.sessionId, origin.orgId, origin.conversationId) === group.key;
    });
    const active = existing.find((prompt) =>
      prompt.status === 'pending' || prompt.status === 'executing');
    if (active) {
      this.activeKeys.set(group.key, active.id);
      if (active.status === 'executing') await this.acknowledgePrompt(active.id);
      return;
    }
    for (const settled of existing) {
      if (settled.status === 'completed') await this.acknowledgePrompt(settled.id);
    }

    const decision = await this.policies.evaluate({
      policyKey: group.policyKey,
      sessionId: group.sessionId,
      conversationId: group.conversationId,
      candidates: group.candidates,
    });
    if (!decision.wake) return;

    const claimed: AgentWakeCandidate[] = [];
    for (const candidate of group.candidates) {
      if (
        await this.dependencies.inbox.claimAgentDelivery(
          candidate.deliveryId,
          candidate.sessionId,
        )
      ) {
        claimed.push(candidate);
      }
    }
    if (claimed.length === 0) {
      this.scheduleLeaseRetry();
      return;
    }

    const prompt = await this.composePrompt(
      group,
      claimed,
      decision.reason,
      session.workspacePath,
    );
    const first = claimed[0];
    let queued: { id: string };
    try {
      queued = await this.dependencies.queuePrompt(group.sessionId, prompt, {
        promptOrigin: 'agent_wake',
        promptProvenance: {
          actor: 'agent',
          origin: 'automation',
          originOrgId: group.orgId,
          originConversationId: group.conversationId,
          originMessageId: first.messageId,
        },
        agentWakeOrigin: {
          policyKey: group.policyKey,
          orgId: group.orgId,
          conversationId: group.conversationId,
          messageIds: claimed.map((candidate) => candidate.messageId),
          targets: claimed.map((candidate) => ({
            deliveryId: candidate.deliveryId,
            sessionId: candidate.sessionId,
          })),
        },
      });
    } catch (error) {
      this.logError('[AgentMentionDispatch] Failed to queue claimed batch:', error);
      this.scheduleLeaseRetry();
      return;
    }
    this.activeKeys.set(group.key, queued.id);
    this.dependencies.requestDrive(group.sessionId, session.workspacePath);
    this.logInfo(
      `[AgentMentionDispatch] Queued ${claimed.length} delivery(s) as one prompt for session ${group.sessionId}`,
    );
  }

  private async composePrompt(
    group: PendingGroup,
    candidates: AgentWakeCandidate[],
    policyReason: string,
    workspacePath: string,
  ): Promise<string> {
    if (group.policyKey === 'documentDecision') return documentDecisionWakePrompt(group.orgId, candidates);
    const feedbackRequest = candidates.find(
      (candidate) => candidate.resourceKind === 'feedbackRequest'
        && candidate.resourceId,
    );
    if (feedbackRequest?.resourceId) {
      const state = await this.dependencies.loadFeedbackRequestState?.(
        workspacePath,
        group.orgId,
        feedbackRequest.resourceId,
      ).catch(() => undefined);
      const projectedResults = state?.request
        ? JSON.stringify({
            requestId: state.request.id,
            lifecycle: state.request.lifecycle,
            visibility: state.request.visibility,
            asks: state.request.asks,
            responses: state.request.responses,
            progress: state.progress,
          }, null, 2)
        : null;
      return [
        'Nimbalyst received an update for a feedback request attached to this session.',
        `Wake policy: ${policyReason}.`,
        `Feedback request: [${feedbackRequest.resourceId}](${feedbackRequestUrn(feedbackRequest.resourceId)}).`,
        ...(projectedResults
          ? ['', 'Server-projected feedback results:', '```json', projectedResults, '```']
          : []),
        '',
        projectedResults
          ? 'Continue the session using these new responses.'
          : 'The feedback results could not be loaded. Retry reading the request before continuing.',
      ].join('\n');
    }
    let context: ConversationEvent[] = [];
    try {
      context = await this.dependencies.loadConversationEvents(
        group.orgId,
        group.conversationId,
      );
    } catch (error) {
      this.logWarn('[AgentMentionDispatch] Failed to hydrate room context; using inbox previews:', error);
    }
    const targetIds = new Set(candidates.map((candidate) => candidate.messageId));
    const contextLines = context
      .filter((event) => event.operation === 'messageCreated')
      .slice(-12)
      .flatMap((event) => {
        const text = eventText(event);
        if (!text) return [];
        const marker = targetIds.has(event.id) ? 'Mention' : 'Context';
        return [`- ${marker} [${event.id}](${messageLink(group.orgId, group.conversationId, event.id)}): ${text}`];
      });
    const fallbackLines = candidates.map((candidate) =>
      `- Mention [${candidate.messageId}](${messageLink(group.orgId, group.conversationId, candidate.messageId)})${candidate.snippet ? `: ${candidate.snippet}` : ''}`);
    const lines = contextLines.length > 0 ? contextLines : fallbackLines;
    return [
      'Nimbalyst dispatched work from an attached team conversation.',
      `Wake policy: ${policyReason}.`,
      `Origin: [open the room message](${messageLink(group.orgId, group.conversationId, candidates[0].messageId)}).`,
      '',
      ...lines,
      '',
      'Continue this as normal session work. Use the room messaging tools to read more context or post the response back to the room when appropriate.',
    ].join('\n');
  }

  private async handlePromptClaimed(promptId: string): Promise<void> {
    await this.acknowledgePrompt(promptId);
  }

  private async acknowledgePrompt(promptId: string): Promise<void> {
    const prompt = await this.dependencies.queueStore.get(promptId);
    const origin = prompt?.documentContext?.agentWakeOrigin;
    if (!origin) return;
    let incomplete = false;
    for (const target of origin.targets) {
      let claimed = await this.dependencies.inbox.claimAgentDelivery(
        target.deliveryId,
        target.sessionId,
      );
      if (!claimed && prompt?.status === 'executing') {
        // The current process may still own the unexpired lease. Completion is
        // idempotent, so try it before waiting for lease recovery.
        claimed = true;
      }
      if (claimed) {
        const completed = await this.dependencies.inbox.completeAgentDelivery(
          target.deliveryId,
          target.sessionId,
        );
        if (!completed) incomplete = true;
      } else incomplete = true;
    }
    if (incomplete) this.scheduleLeaseRetry();
  }

  private scheduleLeaseRetry(): void {
    if (!this.started || this.leaseRetryScheduled) return;
    this.leaseRetryScheduled = this.setTimer(() => {
      this.leaseRetryScheduled = null;
      this.scheduleScan();
    }, CLAIM_LEASE_RETRY_MS);
  }

  private setTimer(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
    return this.dependencies.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
  }

  private clearTimer(timer: ReturnType<typeof setTimeout>): void {
    if (this.dependencies.clearTimer) this.dependencies.clearTimer(timer);
    else clearTimeout(timer);
  }

  private logInfo(message: string): void {
    this.dependencies.logInfo?.(message);
  }

  private logWarn(message: string, error?: unknown): void {
    this.dependencies.logWarn?.(message, error);
  }

  private logError(message: string, error: unknown): void {
    this.dependencies.logError?.(message, error);
  }
}

let productionService: AgentMentionDispatchService | null = null;
let unregisterFeedbackRequestWakePolicy: (() => void) | null = null;

export async function startAgentMentionDispatchService(
  aiService: AIService,
): Promise<AgentMentionDispatchService> {
  if (productionService) return productionService;
  const inbox: TeamInboxService = getTeamInboxService();
  productionService = new AgentMentionDispatchService({
    inbox,
    queueStore: getQueuedPromptsStore(),
    getSession: (sessionId) => AISessionsRepository.get(sessionId),
    queuePrompt: (sessionId, prompt, documentContext) =>
      aiService.queuePromptForSession(sessionId, prompt, undefined, documentContext),
    requestDrive: (sessionId, workspacePath) =>
      aiService.requestQueueDrive(sessionId, workspacePath, 'agent-wake'),
    subscribePromptClaims: subscribeQueuedPromptClaims,
    subscribeSessionState: (listener) => getSessionStateManager().subscribe(listener as never),
    loadConversationEvents: async (orgId, conversationId) => {
      const page = await getConversationService().list({ orgId, conversationId }, undefined, 50);
      return page.events;
    },
    loadFeedbackRequestState: (workspacePath, orgId, requestId) =>
      getFeedbackRequestService().start({ workspacePath, orgId, requestId }),
    logInfo: (message) => logger.main.info(message),
    logWarn: (message, error) => logger.main.warn(message, error),
    logError: (message, error) => logger.main.error(message, error),
  });
  unregisterFeedbackRequestWakePolicy = registerFeedbackRequestWakePolicy(
    productionService.policies,
    {
      targetFor: async (context, candidate, requestId) => {
        const session = await AISessionsRepository.get(context.sessionId);
        if (!session?.workspacePath) return null;
        return {
          workspacePath: session.workspacePath,
          orgId: candidate.orgId,
          requestId,
        };
      },
      loadState: (target) => getFeedbackRequestService().start(target),
    },
  );
  await productionService.start();
  return productionService;
}

export function shutdownAgentMentionDispatchService(): void {
  unregisterFeedbackRequestWakePolicy?.();
  unregisterFeedbackRequestWakePolicy = null;
  productionService?.destroy();
  productionService = null;
}
