#!/usr/bin/env python3
"""Render a resolved orchestration dry-run as a self-contained SVG preview."""

from __future__ import annotations

import argparse
import base64
import html
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence


BRANDS = Path(__file__).resolve().parent.parent / "assets" / "brands"
MARKS = {
    "codex": "openai-official-white.svg",
    "claude": "claude-official.png.b64",
    "agy": "antigravity-official.svg",
    "kimi": "kimi-official.png.b64",
    "9router": "router9-official.svg",
}
PROVIDER_NAMES = {
    "codex": "Codex · OpenAI",
    "claude": "Claude Code",
    "agy": "Agy / Antigravity",
    "kimi": "Kimi Code",
    "custom": "Custom CLI",
}

BACKGROUND = "#101114"
SURFACE = "#1f2125"
FOREGROUND = "#f3f4f6"
LINE = "#c8c8d0"

NODE_W = 186
NODE_H = 70
WORKER_H = 84
COLUMN = NODE_W + 34
PER_ROW = 4
ROW_GAP = 96
BUS = 30
TRUNK = 28
MARGIN = 60


def escaped(value: Any) -> str:
    return html.escape(str(value), quote=True)


def shortened(value: Any, limit: int = 25) -> str:
    text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def plural(count: int, word: str) -> str:
    return f"{count} {word}" if count == 1 else f"{count} {word}s"


def mark(provider: str, x: float, y: float) -> str:
    filename = MARKS.get(provider)
    if not filename:
        return ""
    path = BRANDS / filename
    if path.suffix == ".b64":
        mime = "image/png"
        data = path.read_text(encoding="ascii")
    else:
        mime = "image/svg+xml"
        data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f'<image x="{x}" y="{y}" width="26" height="26" href="data:{mime};base64,{data}"/>'


def node(
    x: float,
    y: float,
    title: str,
    detail: str,
    provider: Optional[str] = None,
    caption: str = "",
) -> str:
    width, height = NODE_W, WORKER_H if caption else NODE_H
    title_x = x + (44 if provider in MARKS else 13)
    border = (
        f"M{x+11} {y+2} Q{x+2} {y+1} {x+2} {y+12} "
        f"L{x+3} {y+height-11} Q{x+3} {y+height+1} {x+14} {y+height-1} "
        f"L{x+width-11} {y+height} Q{x+width+2} {y+height-1} {x+width-1} {y+height-12} "
        f"L{x+width} {y+12} Q{x+width-1} {y+1} {x+width-12} {y+2} Z"
    )
    detail_y = y + (48 if caption else 53)
    caption_text = (
        f'<text x="{x+13}" y="{y+70}" font-size="10" opacity="0.5">{escaped(shortened(caption, 30))}</text>'
        if caption
        else ""
    )
    return (
        f'<g><path d="{border}" fill="{SURFACE}" stroke="{LINE}" stroke-width="1.5"/>'
        f'{mark(provider, x+11, y+10) if provider else ""}'
        f'<title>{escaped(title)} — {escaped(detail)}</title>'
        f'<text x="{title_x}" y="{y+28}" font-size="13" font-weight="600">{escaped(shortened(title, 20 if provider else 25))}</text>'
        f'<text x="{x+13}" y="{detail_y}" font-size="11" opacity="0.72">{escaped(shortened(detail, 29))}</text>'
        f"{caption_text}</g>"
    )


def strokes(*paths: str) -> str:
    body = "".join(f'<path d="{path}"/>' for path in paths)
    return (
        f'<g fill="none" stroke="{LINE}" stroke-width="1.6" stroke-linecap="round" '
        f'stroke-linejoin="round">{body}</g>'
    )


def label(x: float, y: float, text: str) -> str:
    return f'<text x="{x}" y="{y}" font-size="10" opacity="0.7">{escaped(text)}</text>'


def down_head(x: float, y: float) -> str:
    return f"M{x-7} {y-10} Q{x-3} {y-5} {x} {y} Q{x+3} {y-5} {x+7} {y-10}"


def arrow(x1: float, y1: float, x2: float, y2: float) -> str:
    middle = (x1 + x2) / 2
    path = f"M{x1} {y1} C{middle-22} {y1} {middle+16} {y2} {x2-9} {y2}"
    head = f"M{x2-17} {y2-7} Q{x2-12} {y2-3} {x2-9} {y2} Q{x2-13} {y2+5} {x2-17} {y2+7}"
    return strokes(path, head)


def worker_node(worker: Dict[str, Any], x: float, y: float) -> str:
    provider = str(worker.get("provider", "custom"))
    model = worker.get("model") or worker.get("tier") or "default model"
    mode = worker.get("mode", "unknown")
    isolation = " · worktree" if worker.get("isolate") else ""
    return node(
        x,
        y,
        PROVIDER_NAMES.get(provider, provider),
        f"{model} · {mode}{isolation}",
        provider,
        str(worker.get("id", "worker")),
    )


def render(preview: Dict[str, Any], routed_ids: Sequence[str], upstream: str) -> str:
    if preview.get("dryRun") is not True or not isinstance(preview.get("workers"), list):
        raise ValueError("input must be a resolved dry-run JSON object")
    workers = preview["workers"]
    if not workers:
        raise ValueError("the dry-run contains no workers")
    ids = {worker["id"] for worker in workers}
    unknown = set(routed_ids) - ids
    if unknown:
        raise ValueError(f"9router route names unknown workers: {', '.join(sorted(unknown))}")

    rows = [workers[i : i + PER_ROW] for i in range(0, len(workers), PER_ROW)]
    multi = len(rows) > 1
    grid_w = min(len(workers), PER_ROW) * COLUMN - (COLUMN - NODE_W)
    width = max(grid_w + 2 * MARGIN, 820 if routed_ids else 560)
    cx = width / 2
    trunk_left = cx - grid_w / 2 - TRUNK
    trunk_right = cx + grid_w / 2 + TRUNK

    planner_y = 100
    row_ys = [planner_y + NODE_H + BUS + 42 + r * (WORKER_H + ROW_GAP) for r in range(len(rows))]
    first_in_bus = row_ys[0] - BUS
    last_out_bus = row_ys[-1] + WORKER_H + BUS
    integration_y = last_out_bus + 42
    route_y = integration_y + NODE_H + 95
    height = (route_y if routed_ids else integration_y) + NODE_H + 50

    strategy = str(preview.get("strategy", "unknown"))
    out: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}" height="{height}" '
        f'viewBox="0 0 {width:g} {height}" fill="{FOREGROUND}" '
        'style="font-family:system-ui,sans-serif">',
        f'<rect width="100%" height="100%" fill="{BACKGROUND}"/>',
        f"<title>Orchestration strategy: {escaped(strategy)}</title>",
        f'<text x="30" y="40" font-size="20" font-weight="700">{escaped(strategy.title())} strategy</text>',
        f'<text x="30" y="64" font-size="12" opacity="0.7">{plural(len(workers), "worker")} · up to {escaped(preview.get("maxConcurrent", "?"))} concurrent · proposal, not running</text>',
        node(cx - NODE_W / 2, planner_y, "Planner", "Splits and integrates work"),
        node(cx - NODE_W / 2, integration_y, "Integration", "Reviews results and checks"),
    ]

    paths: List[str] = [
        f"M{cx} {planner_y + NODE_H} V{first_in_bus}",
        f"M{cx} {last_out_bus} V{integration_y - 1}",
        down_head(cx, integration_y - 1),
    ]
    if multi:
        paths.append(f"M{trunk_left} {first_in_bus} V{row_ys[-1] - BUS}")
        paths.append(f"M{trunk_right} {row_ys[0] + WORKER_H + BUS} V{last_out_bus}")

    for r, (row, y) in enumerate(zip(rows, row_ys)):
        row_w = len(row) * COLUMN - (COLUMN - NODE_W)
        start = cx - row_w / 2
        centers = [start + i * COLUMN + NODE_W / 2 for i in range(len(row))]
        in_bus = y - BUS
        out_bus = y + WORKER_H + BUS
        if r == 0:
            in_span = (min(centers[0], cx, trunk_left if multi else cx), max(centers[-1], cx))
        else:
            in_span = (trunk_left, centers[-1])
        if r == len(rows) - 1:
            out_span = (min(centers[0], cx), max(centers[-1], cx, trunk_right if multi else cx))
        else:
            out_span = (centers[0], trunk_right)
        paths.append(f"M{in_span[0]} {in_bus} H{in_span[1]}")
        paths.append(f"M{out_span[0]} {out_bus} H{out_span[1]}")
        for worker, center in zip(row, centers):
            out.append(worker_node(worker, center - NODE_W / 2, y))
            paths.append(f"M{center} {in_bus} V{y - 1}")
            paths.append(down_head(center, y - 1))
            paths.append(f"M{center} {y + WORKER_H} V{out_bus}")

    out.append(strokes(*paths))
    out.append(label(cx + 8, (planner_y + NODE_H + first_in_bus) / 2 + 4, "delegate"))
    out.append(label(cx + 8, (last_out_bus + integration_y) / 2 + 4, "result / diff"))

    if routed_ids:
        gap = 66
        left = cx - (3 * NODE_W + 2 * gap) / 2
        middle = left + NODE_W + gap
        right = middle + NODE_W + gap
        mid_y = route_y + NODE_H / 2
        out.append(
            f'<text x="30" y="{route_y - 25}" font-size="12" font-weight="600">Configured API route</text>'
        )
        out.append(node(left, route_y, ", ".join(routed_ids), "Selected agent traffic"))
        out.append(node(middle, route_y, "9router", "Local routing proxy", "9router"))
        out.append(node(right, route_y, shortened(upstream, 23), "Configured upstream"))
        out.append(arrow(left + NODE_W, mid_y, middle, mid_y))
        out.append(arrow(middle + NODE_W, mid_y, right, mid_y))
    out.append("</svg>")
    return "\n".join(out) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("preview", type=Path, help="JSON written by orchestrate.py dry-run --write")
    parser.add_argument("output", type=Path, help="standalone SVG output path")
    parser.add_argument("--via-9router", action="append", default=[], metavar="WORKER_ID")
    parser.add_argument("--upstream", default="Configured model")
    args = parser.parse_args()
    try:
        preview = json.loads(args.preview.read_text(encoding="utf-8"))
        svg = render(preview, args.via_9router, args.upstream)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(svg, encoding="utf-8")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(str(args.output.resolve()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
