import Foundation
import Testing
@testable import AletheModel

@Suite struct SidebarChildOrderTests {
    private func check(_ doc: WorkspaceDocument) {
        let projects = doc.ungroupedProjectIDs + doc.groups.flatMap(\.projectIDs)
        #expect(projects.count == Set(projects).count)
        #expect(Set(projects) == Set(doc.projects.map(\.id)))
        for container in [nil] + doc.groups.map({ Optional($0.id) }) {
            let members = doc.childGroups(of: container).map { SidebarChild.group($0.id) }
                + (container.map { doc.group($0)?.projectIDs ?? [] } ?? doc.ungroupedProjectIDs).map { .project($0) }
            let actual = doc.sidebarChildren(of: container)
            #expect(actual.count == Set(actual).count)
            #expect(Set(actual) == Set(members))
        }
        for group in doc.groups {
            if let parent = group.parentID {
                #expect(doc.group(parent) != nil)
                #expect(!doc.isGroup(parent, inside: group.id))
            }
            // Legacy APIs may leave stale persisted tokens; the reader must discard them.
            let effective = doc.sidebarChildren(of: group.id).map(\.orderToken)
            #expect(effective.count == Set(effective).count)
        }
    }

    @Test func mixedPlacementAndSiblingReordering() {
        var doc = WorkspaceDocument()
        let parent = doc.addGroup(name: "Parent"); check(doc)
        let a = doc.addGroup(name: "A", parent: parent); check(doc)
        let b = doc.addGroup(name: "B", parent: parent); check(doc)
        let p = doc.addProject(name: "P", folder: "/p", in: .group(parent)); check(doc)
        let q = doc.addProject(name: "Q", folder: "/q", in: .group(parent)); check(doc)
        #expect(doc.group(parent)?.childOrder == nil)
        #expect(doc.sidebarChildren(of: parent) == [.group(a), .group(b), .project(p), .project(q)])
        doc.place(.group(a), in: parent, before: nil); check(doc)
        #expect(doc.sidebarChildren(of: parent) == [.group(b), .project(p), .project(q), .group(a)])
        doc.place(.group(a), in: parent, before: .project(q)); check(doc)
        #expect(doc.sidebarChildren(of: parent) == [.group(b), .project(p), .group(a), .project(q)])
        doc.place(.group(a), in: parent, before: .group(b)); check(doc)
        #expect(doc.group(parent)?.childOrder == nil)
        doc.place(.project(p), in: parent, before: .group(b)); check(doc)
        #expect(doc.sidebarChildren(of: parent) == [.group(a), .project(p), .group(b), .project(q)])
        doc.place(.group(b), in: parent, before: .group(a)); check(doc)
        #expect(doc.childGroups(of: parent).map(\.id) == [b, a])
        doc.place(.group(b), in: parent, before: .project(q)); check(doc)
        #expect(doc.childGroups(of: parent).map(\.id) == [a, b])
    }

    @Test func crossContainerMovesAndRootRules() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A"); check(doc)
        let b = doc.addGroup(name: "B"); check(doc)
        let c = doc.addGroup(name: "C", parent: a); check(doc)
        let p = doc.addProject(name: "P", folder: "/p", in: .group(a)); check(doc)
        let q = doc.addProject(name: "Q", folder: "/q"); check(doc)
        doc.place(.group(c), in: a, before: nil); check(doc)
        #expect(doc.group(a)?.childOrder != nil)
        doc.place(.group(c), in: b, before: nil); check(doc)
        #expect(doc.group(a)?.childOrder == nil)
        #expect(doc.group(c)?.parentID == b)
        doc.place(.group(c), in: nil, before: .project(q)); check(doc)
        #expect(doc.childGroups(of: nil).map(\.id) == [a, b, c])
        doc.place(.project(p), in: nil, before: .group(b)); check(doc)
        #expect(doc.ungroupedProjectIDs == [p, q])
        doc.place(.group(c), in: a, before: nil); check(doc)
        #expect(doc.group(c)?.parentID == a)
        doc.place(.project(q), in: a, before: .project(.make())); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.group(c), .project(q)])
    }

    @Test func allRejectedPlacementsAreExactNoOps() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A"); check(doc)
        let b = doc.addGroup(name: "B", parent: a); check(doc)
        let p = doc.addProject(name: "P", folder: "/p"); check(doc)
        let original = doc
        let attempts: [(SidebarChild, GroupID?, SidebarChild?)] = [
            (.project(.make()), a, nil), (.group(.make()), a, nil),
            (.project(p), .make(), nil), (.group(b), .make(), nil),
            (.group(a), a, nil), (.group(a), b, nil),
            (.project(p), a, .project(p)), (.group(b), nil, .group(b))
        ]
        for (item, container, sibling) in attempts {
            doc.place(item, in: container, before: sibling); check(doc)
            #expect(doc == original)
        }
    }

    @Test func deletionSplicesChildrenAndLegacyOperationsSelfHeal() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A"); check(doc)
        let b = doc.addGroup(name: "B", parent: a); check(doc)
        let c = doc.addGroup(name: "C", parent: b); check(doc)
        let p = doc.addProject(name: "P", folder: "/p", in: .group(a)); check(doc)
        let q = doc.addProject(name: "Q", folder: "/q", in: .group(b)); check(doc)
        doc.place(.group(c), in: b, before: nil); check(doc)
        doc.place(.group(b), in: a, before: nil); check(doc)
        doc.deleteGroup(b); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .project(q), .group(c)])
        #expect(doc.group(a)?.childOrder == [SidebarChild.project(p).orderToken,
            SidebarChild.project(q).orderToken, SidebarChild.group(c).orderToken])
        doc.removeProject(q); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .group(c)])
        let r = doc.addProject(name: "R", folder: "/r"); check(doc)
        doc.moveProject(r, to: .group(a), at: 0); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .group(c), .project(r)])
        doc.moveGroup(c, toParent: nil, at: 0); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .project(r)])
        let d = doc.addGroup(name: "D"); check(doc)
        doc.moveGroup(d, toParent: a, at: 0); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .group(d), .project(r)])
        doc.updateGroup(a) { $0.childOrder = ["unknown", SidebarChild.project(p).orderToken,
            SidebarChild.project(p).orderToken, SidebarChild.group(c).orderToken] }
        check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .group(d), .project(r)])
    }

    @Test func codableCompatibility() throws {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A"); check(doc)
        let b = doc.addGroup(name: "B", parent: a); check(doc)
        _ = doc.addProject(name: "P", folder: "/p", in: .group(a)); check(doc)
        let encoder = JSONEncoder()
        let decoder = JSONDecoder()
        let data = try encoder.encode(try #require(doc.group(a)))
        let json = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect(json["childOrder"] == nil)
        #expect(try decoder.decode(ProjectGroup.self, from: data).childOrder == nil)
        doc.place(.group(b), in: a, before: nil); check(doc)
        let group = try #require(doc.group(a))
        #expect(try decoder.decode(ProjectGroup.self, from: encoder.encode(group)) == group)
        let restored = try decoder.decode(WorkspaceDocument.self, from: encoder.encode(doc))
        check(restored)
        #expect(restored == doc)
        #expect(restored.sidebarChildren(of: a) == doc.sidebarChildren(of: a))
    }

    @Test func deletionRestoresDefaultAndPlacementPreservesUnrelatedOrder() {
        var doc = WorkspaceDocument()
        let a = doc.addGroup(name: "A"); check(doc)
        let b = doc.addGroup(name: "B", parent: a); check(doc)
        let c = doc.addGroup(name: "C", parent: b); check(doc)
        let p = doc.addProject(name: "P", folder: "/p", in: .group(a)); check(doc)
        doc.place(.group(b), in: a, before: nil); check(doc)
        doc.deleteGroup(b); check(doc)
        #expect(doc.sidebarChildren(of: a) == [.project(p), .group(c)])
        doc.place(.group(c), in: a, before: .project(p)); check(doc)
        #expect(doc.group(a)?.childOrder == nil)
        let d = doc.addGroup(name: "D"); check(doc)
        let e = doc.addGroup(name: "E", parent: d); check(doc)
        let q = doc.addProject(name: "Q", folder: "/q", in: .group(d)); check(doc)
        doc.place(.group(e), in: d, before: nil); check(doc)
        let untouched = doc.group(d)?.childOrder
        doc.place(.group(c), in: a, before: nil); check(doc)
        #expect(doc.group(d)?.childOrder == untouched)
        for container in [a, d] {
            let list = doc.sidebarChildren(of: container)
            #expect(doc.group(container)?.childOrder == list.map(\.orderToken))
            #expect(Set(list.map(\.orderToken)).count == list.count)
        }
        doc.place(.project(q), in: a, before: .group(c)); check(doc)
        #expect(doc.group(d)?.childOrder == nil)
        // Deleting the only mixed group token restores the parent's default project order.
        doc.deleteGroup(c); check(doc)
        #expect(doc.group(a)?.childOrder == nil)
    }

    @Test func deterministicFuzz() {
        var doc = WorkspaceDocument()
        for i in 0..<6 { _ = doc.addGroup(name: "G\(i)"); check(doc) }
        for i in 0..<12 { _ = doc.addProject(name: "P\(i)", folder: "/\(i)"); check(doc) }
        var seed: UInt64 = 0xA1E7
        func next(_ count: Int) -> Int {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            return Int((seed >> 32) % UInt64(max(1, count)))
        }
        for step in 0..<300 {
            // Replenish after destructive operations so the full run exercises populated containers.
            if doc.groups.count < 6 { _ = doc.addGroup(name: "G\(step)"); check(doc) }
            if doc.projects.count < 12 { _ = doc.addProject(name: "P\(step)", folder: "/f\(step)"); check(doc) }
            let g = doc.groups[next(doc.groups.count)].id
            let p = doc.projects[next(doc.projects.count)].id
            let container: GroupID? = next(3) == 0 ? nil : doc.groups[next(doc.groups.count)].id
            switch next(5) {
            case 0:
                let children = doc.sidebarChildren(of: container)
                let sibling = children.isEmpty || next(3) == 0 ? nil : children[next(children.count)]
                doc.place(next(2) == 0 ? .group(g) : .project(p), in: container, before: sibling)
            case 1: doc.moveProject(p, to: container.map { .group($0) } ?? .ungrouped, at: next(15))
            case 2: doc.moveGroup(g, toParent: container, at: next(7))
            case 3: doc.removeProject(p)
            default: doc.deleteGroup(g)
            }
            check(doc)
        }
    }
}
