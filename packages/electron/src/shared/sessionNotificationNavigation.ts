export interface SessionNotificationNavigationTarget {
  sessionId: string;
  workspacePath: string;
  sourceLabel: string;
  /**
   * Open the session even if it is archived, the way the sidebar does: the archive filter
   * comes on, the row is selected, the session stays archived. Set by deliberate openers
   * (a chip, the tray, an extension panel). A notification click leaves it unset and keeps
   * warning instead, since a stale notification should not resurrect finished work.
   */
  allowArchived?: boolean;
}
