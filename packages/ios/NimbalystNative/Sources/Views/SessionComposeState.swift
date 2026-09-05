import SwiftUI

/// Owned above the adaptive split view so a column remount cannot discard input.
@MainActor
public final class SessionComposeState: ObservableObject {
    @Published var text = ""
    @Published var attachments: [PendingAttachment] = []
    var isApplyingRemoteDraft = false
    var lastSubmitAt = 0
    var lastLocalEditAt = 0

    public init() {}

    /// Call only while the field is unfocused; mutating focused text disrupts IME input.
    func applyRemoteDraft(_ draft: String?, updatedAt: Int?) {
        guard let draft, draft != text else { return }
        // A shorter self-echo cannot erase characters typed after it was sent.
        if !draft.isEmpty && text.hasPrefix(draft) && text.count > draft.count { return }
        // Remounting may observe an uninitialized remote draft. It is not a newer edit.
        if lastLocalEditAt > 0 || lastSubmitAt > 0 {
            guard let updatedAt else { return }
            if updatedAt <= lastLocalEditAt { return }
            if !draft.isEmpty && updatedAt <= lastSubmitAt { return }
        }
        isApplyingRemoteDraft = true
        text = draft
        DispatchQueue.main.async { self.isApplyingRemoteDraft = false }
    }
}
