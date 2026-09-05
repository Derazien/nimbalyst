import XCTest
@testable import NimbalystNative
import GRDB

/// A tapped push notification names a session by id only, and that session has
/// very often not synced to this device yet. These cover the "hold the intent
/// until the row arrives" contract; resolving once at tap time and giving up is
/// what made notification taps silently do nothing.
@MainActor
final class PendingSessionResolverTests: XCTestCase {

    /// Sessions carry a foreign key to their project, so every fixture needs one.
    private func makeDatabase(projectId: String = "p1") throws -> DatabaseManager {
        let db = try DatabaseManager()
        try db.upsertProject(Project(id: projectId, name: "Project"))
        return db
    }

    private func makeSession(id: String, projectId: String = "p1") -> Session {
        Session(
            id: id,
            projectId: projectId,
            titleDecrypted: "Synced later",
            createdAt: 1000,
            updatedAt: 1000
        )
    }

    /// The regression itself: a tap during the post-launch sync window used to
    /// resolve to nothing and be discarded, so the app just sat on the project list.
    func testStillNavigatesWhenSessionHasNotSyncedYet() throws {
        let db = try makeDatabase()

        let plan = SessionNavigation.plan(for: "not-synced-yet", in: db)

        XCTAssertEqual(plan.route.sessionId, "not-synced-yet")
        XCTAssertNil(plan.project, "Project is unknowable until the session syncs")
    }

    func testNavigatesThroughProjectWhenSessionIsKnown() throws {
        let db = try makeDatabase(projectId: "/Users/test/proj")
        try db.upsertSession(makeSession(id: "s0", projectId: "/Users/test/proj"))

        let plan = SessionNavigation.plan(for: "s0", in: db)

        XCTAssertEqual(plan.project?.id, "/Users/test/proj", "Back should land on the session list")
        XCTAssertEqual(plan.route.sessionId, "s0")
    }

    func testSharedSelectionKeepsPendingIntentAndRejectsStaleResolution() throws {
        let db = try makeDatabase()
        let navigation = WorkspaceNavigationState()
        navigation.openSession("late", database: db)
        XCTAssertEqual(navigation.selection, .session("late"))
        XCTAssertNil(navigation.project)

        let session = makeSession(id: "late")
        try db.upsertSession(session)
        navigation.adoptResolvedSession(session, database: db)
        XCTAssertEqual(navigation.project?.id, "p1")
        XCTAssertEqual(navigation.selection, .session("late"))

        navigation.chooseProject(Project(id: "other", name: "Other"))
        navigation.select(.document("file"))
        navigation.adoptResolvedSession(session, database: db)
        XCTAssertEqual(navigation.project?.id, "other")
        XCTAssertEqual(navigation.selection, .document("file"))

        navigation.openSession("late", database: db)
        XCTAssertEqual(navigation.project?.id, "p1")
        XCTAssertEqual(navigation.selection, .session("late"))
    }

    func testComposeStateSurvivesColumnRemountAndRejectsOldRemoteDrafts() {
        let navigation = WorkspaceNavigationState()
        let compose = navigation.composeState(for: "session")
        compose.text = "Keep this draft"
        compose.lastLocalEditAt = 200
        navigation.select(.session("session"))
        navigation.compactColumn = .sidebar
        navigation.compactColumn = .detail
        let remounted = navigation.composeState(for: "session")
        XCTAssertTrue(remounted === compose)
        remounted.applyRemoteDraft(nil, updatedAt: nil)
        remounted.applyRemoteDraft("", updatedAt: nil)
        remounted.applyRemoteDraft("older", updatedAt: 100)
        remounted.applyRemoteDraft("Keep", updatedAt: 300)
        XCTAssertEqual(remounted.text, "Keep this draft")
        remounted.applyRemoteDraft("New desktop draft", updatedAt: 400)
        XCTAssertEqual(remounted.text, "New desktop draft")
        navigation.clearAccount()
        XCTAssertFalse(navigation.composeState(for: "session") === compose)
        XCTAssertTrue(navigation.composeState(for: "session").text.isEmpty)
    }

    func testResolvesSessionAlreadyInDatabaseWithoutWaiting() throws {
        let db = try makeDatabase()
        try db.upsertSession(makeSession(id: "s1"))

        let resolver = PendingSessionResolver(sessionId: "s1", database: db)

        // Synchronous so the warm path never flashes a loading state.
        XCTAssertEqual(resolver.session?.id, "s1")
        XCTAssertFalse(resolver.didTimeOut)
    }

    func testResolvesWhenSessionArrivesFromSyncAfterTap() throws {
        let db = try makeDatabase()
        let resolver = PendingSessionResolver(sessionId: "s2", database: db)

        XCTAssertNil(resolver.session, "Session is not synced yet at tap time")

        let resolved = expectation(description: "resolver picks up the synced session")
        let cancellable = resolver.$session
            .compactMap { $0 }
            .sink { session in
                XCTAssertEqual(session.id, "s2")
                resolved.fulfill()
            }
        defer { cancellable.cancel() }

        // Sync lands a second later, as it does on a cold launch.
        try db.upsertSession(makeSession(id: "s2"))

        wait(for: [resolved], timeout: 5)
    }

    func testReportsTimeoutButKeepsWaiting() throws {
        let db = try makeDatabase()
        let resolver = PendingSessionResolver(sessionId: "s3", database: db, timeout: 0.1)

        let timedOut = expectation(description: "resolver reports the wait is taking too long")
        let timeoutCancellable = resolver.$didTimeOut
            .filter { $0 }
            .sink { _ in timedOut.fulfill() }
        defer { timeoutCancellable.cancel() }

        wait(for: [timedOut], timeout: 5)
        XCTAssertNil(resolver.session)

        // A late arrival must still open the session rather than stay stuck.
        let resolved = expectation(description: "late session still resolves")
        let sessionCancellable = resolver.$session
            .compactMap { $0 }
            .sink { _ in resolved.fulfill() }
        defer { sessionCancellable.cancel() }

        try db.upsertSession(makeSession(id: "s3"))
        wait(for: [resolved], timeout: 5)
    }
}
