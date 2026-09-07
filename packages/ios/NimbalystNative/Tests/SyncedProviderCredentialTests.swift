import XCTest
@testable import NimbalystNative

final class SyncedProviderCredentialTests: XCTestCase {
    func testMissingPreservesAndEmptyDeletesAcrossDecodedSettings() throws {
        var stored: String? = "dummy-existing"
        for (json, expected) in [("{\"version\":1}", "dummy-existing" as String?), ("{\"version\":2,\"openaiApiKey\":\"\"}", nil), ("{\"version\":3,\"openaiApiKey\":\"dummy-new\"}", "dummy-new")] {
            let settings = try JSONDecoder().decode(SyncedSettings.self, from: Data(json.utf8))
            try applySyncedOpenAIKey(settings.openaiApiKey, store: { stored = $0 }, delete: { stored = nil })
            XCTAssertEqual(stored, expected)
        }
    }
    func testFailedStoreDoesNotReportSuccess() {
        struct Failure: Error {}
        XCTAssertThrowsError(try applySyncedOpenAIKey("dummy-new", store: { _ in throw Failure() }, delete: {}))
    }
}
