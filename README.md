# Pi extensions

Personal extensions for [Pi](https://github.com/earendil-works/pi), using the `@earendil-works/pi-coding-agent` extension API. The repository contains the actual extension files; Pi loads them through a directory symlink.

## Installation and updates

```bash
cd /home/solopie/repos/personal/pi-extensions
./sync.sh
```

This links `~/.pi/agent/extensions` to the repository containing `sync.sh`, regardless of your working directory.

- Missing path: creates the parent directories and symlink.
- Correct directory symlink: leaves it unchanged.
- Directory symlink pointing elsewhere: replaces only the symlink, not its destination.
- Existing real directory/file, broken symlink, or symlink to a file: prints an error and exits without changing anything. Move an existing real extensions folder yourself before retrying.

After editing or pulling updates, run `/reload` in Pi while idle, or restart Pi. Changes through either the repository or `~/.pi/agent/extensions` affect the same files. Git commits and pushes are still manual.

## Extension overview

| File | Purpose | Commands |
| --- | --- | --- |
| [`btw.ts`](btw.ts) | Separate read-only side chat while the original agent works | `/btw`; `/close`, `/exit` inside the side chat |
| [`codex-fast-mode.ts`](codex-fast-mode.ts) | Force low reasoning effort for Codex requests | `/fast` |
| [`goal.ts`](goal.ts) | Keep working toward an independently audited objective | `/goal` |
| [`model-gate.ts`](model-gate.ts) | Confirm the active model before sending a prompt | `/model-gate` |
| [`notify.ts`](notify.ts) | Desktop and spoken notification when Pi awaits input | Automatic |
| [`subscription-usage.ts`](subscription-usage.ts) | ChatGPT/Codex subscription utilization in the statusline | `/usage` |
| [`tps.ts`](tps.ts) | Token throughput and latency measurements | `/tps` |
| [`usage-limits.ts`](usage-limits.ts) | Anthropic subscription utilization in the statusline | `/limits` |

## BTW side chat — `btw.ts`

Opens a **native Pi process in a separate tmux window**, using regular TUI mode. The original agent keeps running; its conversation, editor, and scrollback are untouched. The side chat uses normal Pi rendering and normal tmux scrollback, not a custom overlay.

```text
/btw
/btw What are you doing right now?
```

Type ordinary messages to follow up inside the side chat. `/close`, `/exit`, or Pi's normal `/quit` closes it and returns to the original window. Normal Pi cancellation shortcuts apply; Esc is not a special close command. You can also switch windows manually with tmux. Running `/btw` in the parent reopens an existing side window if it is still alive.

Statusline indicators:

- Parent while launching: `Creating BTW session…`
- Parent while open: `BTW session open · /btw: switch to side chat`
- Side chat: `BTW session · /close or /exit: return to original chat`

The parent indicator clears within roughly two seconds after the side window closes.

**Requirements:** Pi running inside tmux, with `pi` and `tmux` on `PATH`. The child uses the parent's selected provider/model and thinking level, plus existing Pi settings/authentication. Providers registered only at runtime by parent extensions are not inherited.

**Isolation:** The side conversation is temporary and unsaved. Tools, MCP, discovered extensions, skills, prompt templates, and project context are disabled. Only its close-command/status extension is loaded. It receives a fixed snapshot of recent public parent messages, tool calls/results, streaming text, and running tools. Private thinking and images are omitted; long content is truncated. The snapshot does not update as the parent advances; close and reopen for a fresh one.

Side requests incur normal model usage. Private temporary files are cleaned up on normal exit; force-killing processes may leave a `pi-btw-*` directory in the system temp directory.

## Codex fast mode — `codex-fast-mode.ts`

Uses **low reasoning effort** for Codex-provider requests and shows `Codex fast: on/off` in the statusline. This is a reasoning setting, not a priority/service-tier switch or a guarantee of faster responses.

```text
/fast                 # Toggle
/fast on
/fast off
/fast toggle
/fast status
```

`enable` and `disable` are aliases for `on` and `off`. Enabling remembers the previous thinking level; disabling restores it when recorded. For Codex models, it sets Pi's thinking level to `low` and patches provider request reasoning fields. The enabled state and previous level persist in `~/.pi/agent/codex-fast-mode.json` under the default agent directory.

## Audited goals — `goal.ts`

Starts work toward an objective and continues until an **independent auditor session** verifies completion with evidence. A `complete_goal` tool lets the main agent claim completion, but the claim alone does not finish the goal.

```text
/goal Implement the feature and verify the tests pass
/goal status
/goal pause
/goal resume
/goal clear
/goal --cheerleader Fix the failing integration tests
/goal cheerleader on
/goal cheerleader off
```

Press **Escape** during an audit (or cheerleader coaching) to cancel it and pause the goal. Use `/goal resume` to continue later. `/goal pause` also cancels without discarding the objective; `/goal clear` cancels and clears it.

Bare `/goal` shows status. Setting a goal normally starts work immediately; a new goal set during an unrelated active run is queued until that run finishes. Replacing an active goal asks for confirmation.

The auditor uses the parent's model and thinking level, with `read`, `grep`, `find`, `ls`, and **bash** tools. It can run tests and commands, so auditing is not a sandbox or strictly read-only. Failed audits trigger further work; optional cheerleader mode adds context-aware coaching after a failed audit.

Goal state is stored in session custom entries and follows the active branch across restarts, tree navigation, and forks. A statusline indicator tracks progress. Current source defaults cap work at 200 goal turns and individual audits at 10 minutes; configuration constants are near the top of the file. Audits/coaching incur extra model usage. Fresh auditor runtimes do not inherit providers registered dynamically by other extensions.

## Model confirmation gate — `model-gate.ts`

Holds the first user prompt until you explicitly confirm the active model. A deliberate `/model` or Ctrl+P selection counts as confirmation by default. The statusline shows the gate state.

```text
/model-gate           # Show status
/model-gate status
/model-gate rearm     # Ask again on the next prompt
/model-gate switch    # Open model selection
```

Edit `RULES` in the source to restrict particular directories to approved model patterns. Rules include subdirectories; the longest matching directory wins. Patterns match `provider/modelId` or the bare model ID (`*` within a path segment, `**` across segments). An unapproved model cannot be confirmed for a governed directory.

By default, `RULES` is empty and `CONFIRM_UNGOVERNED_DIRS` is `true`, so all directories get a soft confirmation gate. `EXPLICIT_SELECT_CONFIRMS` controls whether deliberate model selection satisfies it. Extension-injected messages and mid-stream steering bypass the input gate; this is a user-prompt guard, not process-wide network isolation.

## Awaiting-input notification — `notify.ts`

When the agent settles in terminal mode, is idle, and has no pending messages, it sends a desktop notification saying **“Awaiting your input”** and speaks **“Your cache is gonna invalidate in 5 minutes.”**

**Requirements:** `notify-send` and `espeak-ng` on `PATH`, with desktop/audio support. There are no commands or persisted settings; edit the source to change the messages. The spoken cache warning is a fixed message, not a measured cache-expiry countdown.

## ChatGPT/Codex subscription usage — `subscription-usage.ts`

Displays subscription window utilization and time until reset in the statusline, prefixed with `Codex`.

```text
/usage                # Refresh now and report success or failure
```

Refreshes on session start, after turns, and every five minutes. Uses the ChatGPT usage endpoint and your existing `openai-codex` account. It invokes `pi auth print-bearer-token` to obtain/refresh a bearer token and reads the account ID from Pi's `auth.json`.

**Requirements:** `pi` on `PATH`, an authenticated Codex subscription account, and network access. Automatic refresh errors are quiet; `/usage` reports them. This shows account-wide subscription limits, not just this session's token use.

## Throughput statistics — `tps.ts`

Displays generation speed, time to first token (TTFT), and output-token count in the statusline. Samples are appended to `~/.pi/agent/tps.jsonl` under the default agent directory.

```text
/tps                  # All recorded samples
/tps all
/tps session          # Samples collected by this loaded extension instance
/tps clear            # Delete the log and clear in-memory samples
```

Reports are grouped by provider/model and include median, sustained, and best generation rates, TTFT, estimated prefill rate, and total output tokens. Responses shorter than 20 output tokens are logged but excluded from generation-rate aggregates. Rates use reported output usage (including reasoning tokens) and observed stream timing, so they are estimates rather than controlled benchmarks.

## Anthropic subscription limits — `usage-limits.ts`

Shows Anthropic OAuth subscription utilization and reset countdowns in the statusline, such as `5h 71% ·2h13m · 7d 24% ·1d18h`.

```text
/limits               # Refresh and show the usage report
```

Reads an unexpired Anthropic OAuth access token from Pi's `auth.json` and queries Anthropic's usage endpoint. Refreshes every two minutes and when the agent settles, with automatic requests throttled to at least 20 seconds apart. Countdown rendering updates every 30 seconds. Automatic network/auth failures are silent; `/limits` reports when data is unavailable.

**Requirements:** An Anthropic OAuth subscription login and network access. API-key-only credentials are not sufficient. Expired tokens are skipped until Pi refreshes them during normal provider use.

## Tests

```bash
node --test btw.test.cjs
node --test goal.test.mjs
```

These mock model/session calls and do not make live model requests. The BTW tests locate the installed Pi runtime through `pi` on `PATH` and use its bundled Jiti loader. The goal tests require a recent Node version with `node:module`'s `stripTypeScriptTypes` support. The other extensions do not currently have dedicated test files.

### Goal controls in Pi Remote

The Goal extension provides the optional version-1 `pi-goal:remote:v1` event bridge for Pi Remote. With both extensions updated and loaded, Remote shows Goal controls; without this extension, no controls are advertised. The bridge reuses the same goal command implementation, audit cancellation, persistence and pending-goal activation as `/goal`. It supports structured Start/Edit/Pause/Resume/Clear actions with revision checks, without terminal confirmation prompts or interpreting objective text as a command.

`/goal edit <objective>` also edits locally. An active edit replaces the goal and resets audit progress; a paused edit remains paused. Pause and Clear stop the goal loop/auditor, not an already running parent turn. The Remote panel shows goal/audit status and preserves drafts; concurrent goal changes require reviewing the latest state before overwriting. Run `/remote off`, `/reload`, `/remote` on an updated host, then reopen its session in Remote.

The optional version-1 `pi-remote:queue-pending:v1` handshake lets Remote-owned editable follow-ups take priority over autonomous Goal audits and continuations. Goal skips that settlement boundary while Remote has unpaused queued work; it resumes ordinary auditing after those user messages finish. With Remote absent, this changes nothing. Update/reload both extensions to use this priority behavior.
