import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import { AISessionsRepository } from '@nimbalyst/runtime';
import { deletePendingChildUpdates } from './pendingChildUpdates';

export async function disableParentNotificationsAfterDirectTakeover(session: SessionData): Promise<void> {
  if (!session.createdBySessionId) {
    return;
  }

  const metadata = (session.metadata as Record<string, unknown> | undefined) ?? {};
  if (metadata.notifyParent === false) {
    return;
  }

  await AISessionsRepository.updateMetadata(session.id, {
    metadata: {
      notifyParent: false,
      notifyParentDisabledBy: 'child-user-takeover',
    },
  });

  await deletePendingChildUpdates(session.createdBySessionId, session.id);
}
