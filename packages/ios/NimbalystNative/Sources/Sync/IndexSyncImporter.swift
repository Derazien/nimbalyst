import Foundation
import os

/// Imports an index response while keeping storage failures distinct from
/// failures to authenticate encrypted project identities.
enum IndexSyncImporter {
    struct Result: Sendable {
        var decryptedEntryCount = 0
        var failedSessionDecryptCount = 0
        var storageFailureCount = 0
        var failed = false
        var shouldSuggestRepair = false
    }

    static func process(_ response: IndexSyncResponse, crypto: CryptoManager, database: DatabaseManager) -> Result {
        var result = Result()
        for project in response.projects {
            switch processServerProjectBackground(project, crypto: crypto, database: database) {
            case .updated, .skipped: result.decryptedEntryCount += 1
            case .decryptionFailed: result.failed = true
            case .storageFailed:
                result.decryptedEntryCount += 1
                result.storageFailureCount += 1
                result.failed = true
            }
        }
        for session in response.sessions {
            switch processServerSessionBackground(session, crypto: crypto, database: database) {
            case .updated, .skipped: result.decryptedEntryCount += 1
            case .decryptionFailed:
                result.failedSessionDecryptCount += 1
                result.failed = true
            case .storageFailed:
                result.decryptedEntryCount += 1
                result.storageFailureCount += 1
                result.failed = true
            }
        }
        let isTruncated = response.since == nil && response.totalSessionCount.map { $0 != response.sessions.count } == true
        result.failed = result.failed || isTruncated
        // A delta or mixed-key index cannot establish a device-wide mismatch.
        // Any authenticated entry disproves that this pairing key is unusable.
        result.shouldSuggestRepair = response.since == nil && !isTruncated
            && result.failedSessionDecryptCount > 5 && result.decryptedEntryCount == 0
            && result.storageFailureCount == 0
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")
        if result.failed {
            logger.error("Index import failures: \(result.failedSessionDecryptCount) session decryptions, \(result.storageFailureCount) storage operations; \(result.decryptedEntryCount) entries decrypted")
        }
        do {
            try database.refreshAllProjectStats()
            if let watermark = response.sessions.map(\.updatedAt).max() {
                try database.updateSyncState(SyncState(roomId: "index", lastCursor: nil, lastSequence: 0, lastSyncedAt: watermark))
            }
        } catch {
            result.failed = true
            result.shouldSuggestRepair = false
            logger.error("Failed to finish index import: \(error.localizedDescription)")
        }
        return result
    }

    private enum SyncResult {
        case updated, skipped, decryptionFailed, storageFailed
    }

    /// Process a server project entry on a background thread.
    @discardableResult
    private static func processServerProjectBackground(_ entry: ServerProjectEntry, crypto: CryptoManager, database: DatabaseManager) -> SyncResult {
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID")
            return .decryptionFailed
        }

        // Decrypt project config if present
        var decodedConfig = DecodedProjectConfig.empty
        if let encryptedConfig = entry.encryptedConfig,
           let configIv = entry.configIv,
           let configJson = crypto.decryptOrNil(encryptedBase64: encryptedConfig, ivBase64: configIv) {
            decodedConfig = decodeProjectConfig(fromJson: configJson)
        }

        let name = (projectId as NSString).lastPathComponent
        let project = Project(
            id: projectId,
            name: name,
            sessionCount: entry.sessionCount ?? 0,
            lastUpdatedAt: entry.lastActivityAt,
            commandsJson: decodedConfig.commandsJson,
            actionsJson: decodedConfig.actionsJson,
            gitRemoteHash: entry.gitRemoteHash
        )

        do {
            try database.upsertProject(project)
            // Server's sessionCount includes archived sessions; recompute locally
            // so the displayed count matches what SessionListView actually shows.
            try database.refreshSessionCount(forProject: projectId)
        } catch {
            logger.error("Failed to upsert project: \(error.localizedDescription)")
            return .storageFailed
        }
        return .updated
    }

    /// Process a server session entry on a background thread.
    @discardableResult
    private static func processServerSessionBackground(_ entry: ServerSessionEntry, crypto: CryptoManager, database: DatabaseManager) -> SyncResult {
        let logger = Logger(subsystem: "com.nimbalyst.app", category: "SyncManager")

        let existing = try? database.session(byId: entry.sessionId)

        guard let projectId = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedProjectId,
            ivBase64: entry.projectIdIv
        ) else {
            logger.warning("Failed to decrypt project ID for session \(entry.sessionId)")
            return .decryptionFailed
        }

        // Even unchanged rows must authenticate with this manager's current key
        // before they can count as evidence that pairing is valid.
        if let existing, existing.updatedAt == entry.updatedAt {
            return .skipped
        }

        // Ensure the project exists
        if (try? database.writer.read({ db in try Project.fetchOne(db, id: projectId) })) == nil {
            let projectName = (projectId as NSString).lastPathComponent
            let project = Project(id: projectId, name: projectName, lastUpdatedAt: entry.updatedAt)
            try? database.upsertProject(project)
        }

        let titleDecrypted = crypto.decryptOrNil(
            encryptedBase64: entry.encryptedTitle,
            ivBase64: entry.titleIv
        )

        var clientMeta: ClientMetadata?
        if let encryptedMeta = entry.encryptedClientMetadata,
           let metaIv = entry.clientMetadataIv,
           let metaJson = crypto.decryptOrNil(encryptedBase64: encryptedMeta, ivBase64: metaIv),
           let metaData = metaJson.data(using: .utf8) {
            clientMeta = try? JSONDecoder().decode(ClientMetadata.self, from: metaData)
        }

        // Encode tags array to JSON string for storage
        var tagsJson: String? = nil
        if let tags = clientMeta?.tags, !tags.isEmpty,
           let data = try? JSONEncoder().encode(tags) {
            tagsJson = String(data: data, encoding: .utf8)
        }

        let session = Session(
            id: entry.sessionId,
            projectId: projectId,
            titleEncrypted: entry.encryptedTitle,
            titleIv: entry.titleIv,
            titleDecrypted: titleDecrypted,
            // Preserve local provider/model/mode when the server omits them.
            // Older server rows can be missing these fields, and overwriting
            // with nil wipes the session's identity (e.g. the session-list
            // badge would lose "Opus 4.7" because the incoming entry had a
            // null model column). Matches the pattern used for every other
            // field below.
            provider: entry.provider ?? existing?.provider,
            model: entry.model ?? existing?.model,
            mode: entry.mode ?? existing?.mode,
            sessionType: entry.sessionType ?? existing?.sessionType,
            parentSessionId: entry.parentSessionId ?? existing?.parentSessionId,
            agentRole: entry.agentRole ?? existing?.agentRole,
            createdBySessionId: entry.createdBySessionId ?? existing?.createdBySessionId,
            phase: clientMeta?.phase ?? existing?.phase,
            tagsJson: tagsJson ?? existing?.tagsJson,
            worktreeId: entry.worktreeId ?? existing?.worktreeId,
            hostDeviceId: entry.hostDeviceId ?? existing?.hostDeviceId,
            isArchived: entry.isArchived ?? existing?.isArchived ?? false,
            isPinned: entry.isPinned ?? existing?.isPinned ?? false,
            branchedFromSessionId: entry.branchedFromSessionId ?? existing?.branchedFromSessionId,
            branchPointMessageId: entry.branchPointMessageId ?? existing?.branchPointMessageId,
            branchedAt: entry.branchedAt ?? existing?.branchedAt,
            isExecuting: entry.isExecuting ?? existing?.isExecuting ?? false,
            hasQueuedPrompts: clientMeta?.hasPendingPrompt ?? entry.hasPendingPrompt ?? existing?.hasQueuedPrompts ?? false,
            contextTokens: clientMeta?.currentContext?.tokens ?? existing?.contextTokens,
            contextWindow: clientMeta?.currentContext?.contextWindow ?? existing?.contextWindow,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            lastSyncedSeq: entry.messageCount ?? existing?.lastSyncedSeq ?? 0,
            lastReadAt: entry.lastReadAt ?? existing?.lastReadAt,
            lastMessageAt: entry.lastMessageAt ?? existing?.lastMessageAt,
            // "" from remote means "cleared" -> nil locally; nil means "not sent" -> keep existing
            draftInput: clientMeta?.draftInput != nil ? (clientMeta!.draftInput!.isEmpty ? nil : clientMeta!.draftInput!) : existing?.draftInput,
            draftUpdatedAt: clientMeta?.draftUpdatedAt ?? existing?.draftUpdatedAt
        )

        do {
            try database.upsertSession(session)
            try database.updateProjectLastActivity(projectId: projectId, activityAt: entry.updatedAt)

            // Decrypt and store queued prompts from remote for display
            if let encryptedPrompts = entry.encryptedQueuedPrompts, !encryptedPrompts.isEmpty {
                var decrypted: [QueuedPrompt] = []
                for ep in encryptedPrompts {
                    guard let plaintext = crypto.decryptOrNil(encryptedBase64: ep.encryptedPrompt, ivBase64: ep.iv) else {
                        continue
                    }
                    decrypted.append(QueuedPrompt(
                        id: ep.id,
                        sessionId: entry.sessionId,
                        promptTextEncrypted: ep.encryptedPrompt,
                        iv: ep.iv,
                        createdAt: ep.timestamp,
                        sentAt: nil,
                        promptTextDecrypted: plaintext,
                        source: ep.source ?? "desktop"
                    ))
                }
                try? database.replaceQueuedPrompts(forSession: entry.sessionId, with: decrypted)
            } else if entry.queuedPromptCount == 0 || entry.encryptedQueuedPrompts?.isEmpty == true {
                try? database.deleteRemoteQueuedPrompts(forSession: entry.sessionId)
            }

            return .updated
        } catch {
            logger.error("Failed to upsert session: \(error.localizedDescription)")
            return .storageFailed
        }
    }

}
