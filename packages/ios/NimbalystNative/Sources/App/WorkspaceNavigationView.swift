import SwiftUI

/// Stable identities shared by sidebar links, notification taps, and the detail pane.
public enum WorkspaceSelection: Hashable {
    case session(String)
    case document(String)
}

@MainActor
final class WorkspaceNavigationState: ObservableObject {
    @Published private(set) var project: Project?
    @Published private(set) var selection: WorkspaceSelection?
    @Published var compactColumn: NavigationSplitViewColumn = .sidebar
    private var composeStates: [String: SessionComposeState] = [:]

    init(project: Project? = nil) {
        self.project = project
    }

    func chooseProject(_ project: Project?) {
        selection = nil
        self.project = project
        compactColumn = .sidebar
    }

    func select(_ selection: WorkspaceSelection?) {
        self.selection = selection
        if selection != nil { compactColumn = .detail }
    }

    func composeState(for sessionId: String) -> SessionComposeState {
        if let existing = composeStates[sessionId] { return existing }
        let state = SessionComposeState()
        composeStates[sessionId] = state
        return state
    }

    func clearAccount() {
        composeStates.removeAll()
        chooseProject(nil)
    }

    func openSession(_ sessionId: String, database: DatabaseManager?) {
        let plan = SessionNavigation.plan(for: sessionId, in: database)
        project = plan.project
        select(.session(sessionId))
    }

    /// A late sync response must not replace a newer sidebar choice.
    func adoptResolvedSession(_ session: Session, database: DatabaseManager?) {
        guard selection == .session(session.id) else { return }
        project = SessionNavigation.plan(for: session.id, in: database).project
    }
}

/// Keep the same split view and selection mounted as SwiftUI expands/collapses columns.
struct WorkspaceNavigationView: View {
    @EnvironmentObject private var appState: AppState
    @ObservedObject var navigation: WorkspaceNavigationState
    @State private var columnVisibility: NavigationSplitViewVisibility = .all

    private var selection: Binding<WorkspaceSelection?> {
        Binding(get: { navigation.selection }, set: { navigation.select($0) })
    }

    var body: some View {
        NavigationSplitView(columnVisibility: $columnVisibility, preferredCompactColumn: $navigation.compactColumn) {
            Group {
                if let project = navigation.project {
                    SessionListView(project: project, selection: selection)
                        .id(project.id)
                        .toolbar {
                            ToolbarItem(placement: .navigation) {
                                Button {
                                    navigation.chooseProject(nil)
                                } label: {
                                    Label("Projects", systemImage: "folder")
                                }
                                .accessibilityIdentifier("Choose Project")
                            }
                        }
                } else {
                    ProjectListView { project in
                        navigation.chooseProject(project)
                        appState.configureVoiceAgent(forProject: project.id)
                        AnalyticsManager.shared.capture("mobile_project_selected")
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 360)
        } detail: {
            detail
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: appState.databaseManager.map(ObjectIdentifier.init)) { previous, _ in
            // Initial database hydration must retain a cold-launch notification intent.
            if previous != nil { navigation.clearAccount() }
        }
    }

    @ViewBuilder
    private var detail: some View {
        if let database = appState.databaseManager {
            switch navigation.selection {
            case .session(let sessionId):
                PendingSessionView(sessionId: sessionId, database: database, composeState: navigation.composeState(for: sessionId)) { session in
                    navigation.adoptResolvedSession(session, database: database)
                }
                .id(sessionId)
            case .document(let documentId):
                #if canImport(UIKit)
                if let document = try? database.document(byId: documentId) {
                    DocumentEditorView(document: document)
                        .id(documentId)
                }
                #endif
            case nil:
                ContentUnavailableView("Select a session or file", systemImage: "sidebar.left")
            }
        }
    }
}
