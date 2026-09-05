/// An empty local index is not authoritative until its server response is imported.
public enum IndexLoadState: Equatable {
    case loading
    case loaded
    case failed
}
