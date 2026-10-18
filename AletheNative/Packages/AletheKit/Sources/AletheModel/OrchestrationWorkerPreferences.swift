import Foundation

/// The web preference keys preserve nil (defaults) separately from an explicitly empty list.
public struct OrchestratorShortcut: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var text: String
    public var rule: String
    public init(id: String = "custom-" + UUID().uuidString, name: String, text: String = "", rule: String = "any") {
        self.id = id; self.name = name; self.text = text; self.rule = rule
    }
    public func matches(done: Bool, isolated: Bool, native: Bool) -> Bool {
        !native && (rule == "any" || (done && (rule == "finished" || isolated)))
    }
    public func render(jobID: String, agent: String, worktree: String?, project: String?) -> String {
        let values = ["jobId": jobID, "agent": agent, "branch": "alethe/agent-" + jobID,
                      "worktree": worktree ?? "", "project": project ?? ""]
        // Replace from the end so substituted values containing placeholders remain literal.
        let pattern = #"\{(jobId|agent|branch|worktree|project)\}"#
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return text }
        var output = text
        for match in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let range = Range(match.range, in: output), let key = Range(match.range(at: 1), in: text) else { continue }
            output.replaceSubrange(range, with: values[String(text[key])] ?? "")
        }
        return output
    }
}

public struct WorkerRuleSet: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var text: String
    public init(id: String = "custom-" + UUID().uuidString, name: String, text: String = "") {
        self.id = id; self.name = name; self.text = text
    }
    public var isProtected: Bool { id == "general" }
    public static func fold(_ name: String) -> String {
        let decomposed = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().decomposedStringWithCanonicalMapping
        return String(String.UnicodeScalarView(decomposed.unicodeScalars.filter { !$0.properties.isDiacritic }))
    }
    public func isDuplicate(_ name: String, in sets: [Self]) -> Bool {
        sets.contains { $0.id != id && Self.fold($0.name) == Self.fold(name) }
    }
    public static func uniqueName(_ base: String, in sets: [Self]) -> String {
        let names = Set(sets.map { fold($0.name) })
        var next = base
        var suffix = 2
        while names.contains(fold(next)) { next = "\(base) \(suffix)"; suffix += 1 }
        return next
    }
    public static let defaults: [Self] = [
        .init(id: "general", name: "General", text: "# General\n\n- Understand before you change: read the code around what you touch and follow the file's patterns,\n  not your preferences.\n- Make the smallest change that solves it. No unrequested cleanups along the way.\n- Look for an existing helper or component before writing another; promote code to a shared place\n  only when a second consumer needs it.\n- Record an architecture decision as a versioned ADR committed in the same change: context,\n  alternatives rejected, consequences. A decision that lives only in your head is next quarter's\n  rework. From now on only — do not document past decisions retroactively.\n- Validate at the boundary and fail fast. Do not add a defence that masks a value you know is there:\n  it delays the failure and erases the evidence.\n- No magic strings or numbers: a domain value becomes a named constant, and lists derive from that\n  single source.\n- Avoid nesting: guard clauses and early returns; never `else` after `return`.\n- Do not mutate parameters or shared state — transform and return.\n- Write the failing test first and watch it fail for the right reason. Name the test after the\n  acceptance criterion, and cover a happy path and an error path.\n- A green suite is not proof it works: exercise it the way the person will before calling it done.\n- Confirm the verification verified: check that the command actually covered the files you changed.\n- Never weaken shared lint, hooks or CI to make your change pass. Fix the code.\n- Before trusting a mock of an external dependency, observe the real thing once and mirror what you\n  saw, not what you assumed.\n- In a design document, cite only symbols you actually opened, with file and line; mark anything\n  unverified as unverified.\n- No debug prints in what ships — use the project's logger.\n- No fire-and-forget async that swallows failure: await it, return it, or handle it.\n- Comments explain the non-obvious why, at the density the file already uses.\n- If you generated an artifact a person will open, open it back and check its content and format.\n- Do not commit, push or touch version control unless asked. Secrets never enter code or logs.\n"),
        .init(id: "backend", name: "Backend", text: "# Backend\n\n- Layer strictly: the entrypoint validates and delegates, the service orchestrates without touching\n  the datastore, and one data-access layer talks to the database.\n- Every connection to an external resource goes through one owned client — pool, timeout and circuit\n  breaker in one place, never the raw driver spread across the code.\n- Always parameterized queries. Concatenating a value into a query is a defect.\n- Release every resource — connection, lock, file handle — in a `finally`, not only on the happy\n  path.\n- Every `catch` funnels into one handler that preserves the intended status and converts the unknown\n  into a safe error. Never swallow, never return empty from a catch, never rethrow raw.\n- No stack trace reaches the client: map failures to the right status and a safe message.\n- The API is the source of truth for business rules. Never assume the client already validated.\n- Datastores are read-only by default; a write needs explicit per-case authorization, and check the\n  target is really local. \"Dev\" in a name does not mean safe.\n- A schema-changing or seeding command never points at a shared database.\n- A bug is confirmed when an automated test reproduces it through the real path. The regression test\n  asserts the correct behaviour — failing now, passing after the fix.\n- Test the real HTTP layer, not only a service with a mocked dependency: a wrong route or a missing\n  middleware never shows up in a mock.\n- User-facing and error messages live in one place, ready for translation.\n"),
        .init(id: "frontend", name: "Frontend", text: "# Frontend\n\n- A new screen ships with an end-to-end test in the same change, walking the flow the way a person\n  walks it.\n- The server is the authority; client-side validation is for responsiveness, not truth.\n- Use the project's design-system primitive before hand-building a button, table or dialog.\n- Server data goes through the app's data layer — no ad-hoc HTTP call inside a component.\n- Do not fetch in a mount effect; effects are for real side effects (focus, subscriptions), each\n  with a line saying why.\n- Componentize: screens assembled from small components, logic in hooks, no god component.\n- Accessibility and responsiveness are not extras: no horizontal overflow at standard widths, and\n  every interactive element carries a label.\n- The contents of a modal, tab or accordion load when it opens, not when the page mounts — confirm\n  in the network tab that the request waits for the click. If the page needs part of that data, give\n  it its own light endpoint.\n- Open it in a real browser and interact — filter, paginate, empty, loading — before calling it\n  done. For a visual bug, read the computed style; it beats a screenshot.\n- The screen shows the real state: loading, empty and error too.\n- Visible copy and error-message extraction live in one place.\n")
    ]
}
