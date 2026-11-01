# Plan architecture diagram

When the user asks to see the runner strategy, render the **resolved dry-run**, not an idealized preset.
The diagram must identify the lead, each actual worker, its CLI, model or tier when known,
read-only/write mode, worktree isolation, and the relationship between workers. Show a proxy such
as 9router only when the user's selected route actually uses it. If a model or route is unknown,
say so in the node instead of inventing it.

```text
python scripts/orchestrate.py dry-run <plan.json> --write <preview.json>
python scripts/diagram.py <preview.json> <architecture.svg>
python scripts/diagram.py <preview.json> <architecture.svg> --via-9router <worker-id> --upstream <known-model>
```

`diagram.py` embeds the vendor marks in a standalone SVG, so the preview works offline after the
skill is installed. Pass `--via-9router` once for each worker **confirmed** to use that proxy.
Omit `--upstream` when the model is not known. Open or display the SVG for the user before running
the plan; report its absolute path. The SVG labels itself as a proposal, not a running session.

Use this structure for a visual preview before execution:

```text
Lead / planner
  ├─ task → worker A [CLI, model/tier, mode]
  └─ task → worker B [CLI, model/tier, mode]
worker A ─ result/diff → Lead
worker B ─ result/diff → Lead
worker A ─ API traffic → 9router ─ upstream → model (only if configured)
```

Draw delegation and return as distinct labeled arrows. Sequential review arrows should follow
the actual waves; parallel branches should share a starting point. Use rounded rectangular nodes,
slightly irregular arrow paths, and restrained hand-drawn strokes inspired by Excalidraw. Keep
labels readable and colors from the host app's design tokens.

Use official, unaltered vendor marks only when an asset with a traceable official source is
available. Preserve each mark's aspect ratio, clear space, and approved colors. Record the source
with the asset. For an unknown or unavailable logo, show the tool name in text; never draw an
approximation or present a generic symbol as that vendor's official mark. Treat 9router as a
separate routing tool, not as the upstream model's brand.

Bundled mark sources:

- OpenAI mark for Codex (white variant): https://openai.com/brand/ (official OpenAI logo archive)
- Claude icon: https://www.anthropic.com/news (official Anthropic press kit)
- Antigravity icon: https://www.antigravity.google/press
- Kimi icon: https://github.com/MoonshotAI/Branding-Guide
- 9router favicon: https://github.com/decolua/9router/blob/master/public/favicon.svg

The diagram is an explanation and preview. Do not imply that a worker, proxy, or model has started
because it appears in the proposed architecture. Update the view after a run only from observed
state and outcomes.
