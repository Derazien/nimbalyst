/**
 * IPC Handlers for OS Notifications
 */

import { BrowserWindow } from 'electron';
import { notificationService } from '../services/NotificationService';
import { logger } from '../utils/logger';
import {
  isOSNotificationsEnabled,
  setOSNotificationsEnabled,
  isNotifyWhenFocusedEnabled,
  setNotifyWhenFocusedEnabled,
  isSessionBlockedNotificationsEnabled,
  setSessionBlockedNotificationsEnabled,
} from '../utils/store';
import { safeHandle } from '../utils/ipcRegistry';

export function registerNotificationHandlers(): void {
  // Show OS notification
  safeHandle('notifications:show', async (event, options) => {
    try {
      // Get the window ID from the event
      const window = BrowserWindow.fromWebContents(event.sender);
      const windowId = window?.id;

      await notificationService.showNotification({
        ...options,
        windowId,
      });

      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error showing notification:', error);
      return { success: false, error: String(error) };
    }
  });

  // Clear notification for a session
  safeHandle('notifications:clear', async (_event, sessionId: string) => {
    try {
      notificationService.clearNotification(sessionId);
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error clearing notification:', error);
      return { success: false, error: String(error) };
    }
  });

  // Clear all notifications
  safeHandle('notifications:clear-all', async () => {
    try {
      notificationService.clearAllNotifications();
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error clearing all notifications:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('notifications:consume-pending-navigation', async (_event, workspacePath: string) => {
    if (!workspacePath || typeof workspacePath !== 'string') {
      throw new Error('notifications:consume-pending-navigation requires workspacePath');
    }
    return notificationService.consumePendingNavigation(workspacePath);
  });

  /**
   * Open a session, in this project or another one, from anywhere.
   *
   * Same routing a notification click uses. Any surface that knows a session id and the
   * project it belongs to can call this instead of hunting for the row in its own window,
   * which is what every improvised opener did and why they broke across projects.
   */
  safeHandle(
    'sessions:open-in-project',
    async (_event, args: { sessionId?: string; workspacePath?: string; sourceLabel?: string }) => {
      const sessionId = typeof args?.sessionId === 'string' ? args.sessionId.trim() : '';
      const workspacePath = typeof args?.workspacePath === 'string' ? args.workspacePath.trim() : '';
      if (!sessionId || !workspacePath) {
        return { ok: false, error: 'sessions:open-in-project requires sessionId and workspacePath' };
      }
      try {
        return notificationService.routeSessionNavigation({
          sessionId,
          workspacePath,
          sourceLabel:
            typeof args?.sourceLabel === 'string' && args.sourceLabel.trim()
              ? args.sourceLabel.trim()
              : `Session ${sessionId.slice(0, 8)}`,
          // A deliberate open, unlike a notification click: an archived session opens and stays
          // archived, as it does from the sidebar.
          allowArchived: true,
        });
      } catch (error) {
        logger.main.error('[NotificationHandlers] sessions:open-in-project failed:', error);
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  // Get OS notifications enabled status
  safeHandle('notifications:get-enabled', async () => {
    try {
      return isOSNotificationsEnabled();
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error getting notification status:', error);
      return false;
    }
  });

  // Set OS notifications enabled status
  safeHandle('notifications:set-enabled', async (_event, enabled: boolean) => {
    try {
      setOSNotificationsEnabled(enabled);
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error setting notification status:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('notifications:show-test', async () => {
    try {
      await notificationService.showTestNotification();
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error showing test notification:', error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('notifications:open-system-settings', async () => {
    try {
      await notificationService.openSystemNotificationSettings();
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error opening notification settings:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get notify when focused status
  safeHandle('notifications:get-notify-when-focused', async () => {
    try {
      return isNotifyWhenFocusedEnabled();
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error getting notify-when-focused status:', error);
      return false;
    }
  });

  // Set notify when focused status
  safeHandle('notifications:set-notify-when-focused', async (_event, enabled: boolean) => {
    try {
      setNotifyWhenFocusedEnabled(enabled);
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error setting notify-when-focused status:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get session blocked notifications enabled status
  safeHandle('notifications:get-blocked-enabled', async () => {
    try {
      return isSessionBlockedNotificationsEnabled();
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error getting session-blocked-notifications status:', error);
      return true; // Default to true
    }
  });

  // Set session blocked notifications enabled status
  safeHandle('notifications:set-blocked-enabled', async (_event, enabled: boolean) => {
    try {
      setSessionBlockedNotificationsEnabled(enabled);
      return { success: true };
    } catch (error) {
      logger.main.error('[NotificationHandlers] Error setting session-blocked-notifications status:', error);
      return { success: false, error: String(error) };
    }
  });

  logger.main.info('[NotificationHandlers] Notification IPC handlers registered');
}
