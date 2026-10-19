import Foundation

/// Ranked pointer collisions, matching NormalProjectSidebar's rank-then-area ordering.
public struct SidebarDropCandidate: Sendable {
    public let bounds: CGRect
    public let rank: Int

    public init(bounds: CGRect, rank: Int) {
        self.bounds = bounds
        self.rank = rank
    }
}

public enum SidebarDropResolution {
    public static func winner(at pointer: CGPoint, candidates: [SidebarDropCandidate]) -> Int? {
        candidates.indices.filter { candidates[$0].bounds.contains(pointer) }.min { a, b in
            let lhs = candidates[a], rhs = candidates[b]
            if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
            let leftArea = lhs.bounds.width * lhs.bounds.height
            let rightArea = rhs.bounds.width * rhs.bounds.height
            if leftArea != rightArea { return leftArea < rightArea }
            return a < b
        }
    }

    public static func edge(at y: CGFloat, row: CGRect) -> SidebarDropEdge {
        y < row.midY ? .before : .after
    }
}
