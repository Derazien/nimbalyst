import Foundation

/// Missing preserves a local key; an explicit empty value is a deletion.
@discardableResult
func applySyncedOpenAIKey(_ value: String?, store: (String) throws -> Void, delete: () -> Void) throws -> Bool {
    guard let value else { return false }
    if value.isEmpty { delete() } else { try store(value) }
    return true
}
