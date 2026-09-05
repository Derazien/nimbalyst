#if DEBUG
import Foundation

extension AppState {
    /// Deterministic delayed, empty index for testing the production list screens.
    public static func forLoadingScreenshots() -> AppState {
        let state = AppState(databaseManager: try! DatabaseManager())
        state.screenshotMode = true
        state.isConnected = true
        state.indexLoadState = .loading
        Task { @MainActor [weak state] in
            try? await Task.sleep(nanoseconds: 10_000_000_000)
            state?.indexLoadState = .loaded
        }
        return state
    }
}
#endif
