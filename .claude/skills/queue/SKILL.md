---
name: queue
description: Defer a prompt until an Alethe worker has capacity, or inspect the prompt queue.
---

# Prompt queue

- `/queue <prompt>` calls `alethe_queue_add` with the supplied prompt and the project's absolute
  `cwd`. Default agent: `codex`; use `claude` when explicitly requested.
- `/queue` without a prompt calls `alethe_queue_list`. Report the real labels, states and reset
  times returned by the tool. Do not invent timers or launch shell sleeps.
- By default, prompts release when the agent has room. `at` accepts an ISO 8601 date;
  `afterJob` accepts an existing job ID and releases after that job settles (including failure or
  cancellation). These options are mutually exclusive and both still respect agent fitness.
- Higher `priority` runs first; equal priorities keep insertion order. `alethe_queue_reorder`
  accepts `ids` in the desired order and clears existing priorities.
- `isolate: true` uses the normal delegate worktree path. Queue state persists across relaunch.
- `alethe_queue_cancel {ids}` cancels pending prompts or their running workers.
  `alethe_queue_run_now {ids}` explicitly bypasses release conditions and usage warnings but still
  respects the orchestrator concurrency limit. Use it only when the person requests it.
- `alethe_delegate` also accepts `queue: true`: if the requested agent is strained or rate-limited,
  its tasks become queue items and the response contains `queueIds` and `resetsAt`.
- A queued worker that reports a usage limit returns to waiting with its parsed reset time.
  An unknown reset waits for a healthy usage reading. Other failures remain failed for review.
  Interrupted launches after relaunch also remain failed for review, avoiding automatic duplicates.
- Queue availability requires the native Alethe orchestrator and its MCP tools. If unavailable,
  explain that requirement instead of simulating a queue.
