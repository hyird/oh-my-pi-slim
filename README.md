# OMP (`@hyird/oh-my-pi-slim`)

OMP is a lightweight Pi-native agent orchestration extension inspired by the [upstream project](https://github.com/alvinunreal/oh-my-opencode-slim). It offers an Orchestrator or Council main-agent prompt, five specialist roles, parallel delegation, three-perspective Council review, and per-role child model and thinking settings. It is not an OpenCode plugin or a drop-in implementation of upstream features.

## Install and configure

Install from GitHub:

```sh
pi install git:github.com/hyird/oh-my-pi-slim
```

Restart Pi or run `/reload`. Run `/omp` **without arguments** to open settings; there are no `/omp` subcommands. Select the default main role (`pi`, `orchestrator`, or `council`). Each of the five specialist roles has one settings row: choose its model, then its thinking level; both choices save together. The model picker follows Pi's enabled model scope (`/scoped-models`); disabled models cannot be selected or launched as configured specialist overrides. Council reviewers always inherit the main session's model and thinking level, so Council has no child settings row. Explorer, Librarian, Oracle, Designer, and Fixer cannot be main roles. Choose “Inherit” in either picker to use the current Pi session's model or thinking level. Thinking choices are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; Pi clamps unsupported levels to the selected model's capabilities. Arrow keys navigate, Enter selects/saves, typing searches available models, and Esc goes back or closes settings. RPC mode uses equivalent selection dialogs. Invalid legacy main-role settings fall back to `orchestrator` without discarding specialist overrides.

Pi controls the main session model and thinking level. OMP's specialist model and thinking settings affect only children; unset overrides inherit the delegating Pi session's values. Choosing `pi` keeps Pi's native main prompt and disables OMP delegation tools, so no OMP child agents are called. Choosing `orchestrator` or `council` adds the corresponding role prompt without restricting main-session tools. Council runs three separate reviews using the main session's model and thinking level; these are different perspectives, **not** cross-model consensus. The main model synthesizes their results. Legacy Council overrides in `omp.json` are ignored.

Settings live in `getAgentDir()/omp.json` (normally `~/.pi/agent/omp.json`, or under `PI_CODING_AGENT_DIR`). They do not change Pi authentication or the main model. For example:

```json
{
  "defaultAgent": "orchestrator",
  "models": {
    "explorer": "openai-codex/gpt-5.3-codex-spark",
    "oracle": "openai-codex/gpt-5.5"
  },
  "thinking": {
    "explorer": "low",
    "oracle": "high"
  }
}
```

If a previously saved specialist model is later disabled, OMP switches it to the current Pi model when that model is enabled, otherwise to the first available enabled model, and shows a notification. This happens when a session starts, `/omp` opens, or delegation runs. If no enabled model is available, `/omp` marks the role and delegation stops before translation or child work.

## MCP mapping

With pi-mcp-adapter, Orchestrator can use verified non-context7 namespace proxies or the `mcp` gateway with an explicit server (for example `mcp({server:'gh_grep',tool:'search',args:{query:'repo'}})`). Unscoped gateway search, scripts, context7, and unattributed direct MCP tools are blocked; Council gets no MCP tools. Librarian children use an exclusive allowlist of public context7 and gh_grep namespace proxies; other specialists get none. Native `pi` retains its MCP tools. If the adapter exposes only direct tools, Orchestrator must use the scoped gateway instead. This is a tool-level policy, **not a network sandbox**: shell commands can still access the network. See [MCP boundaries](docs/references.md#mcp-defaults-mapping-pi-mcp-adapter-2370).

## Delegation and conversations

The main model decides whether to use `omp_delegate` (one specialist task or up to four tasks) or `omp_council` (three review perspectives). Both tools start background work immediately. OMP runs at most three children across all calls; others stay queued in the original task card. The main model can continue independent work, then receives an automatic completion message. There is no separate task status/result tool. Switching sessions or shutting down cancels active work. A prompt cannot guarantee delegation on every turn. Orchestrator favors direct work for one isolated small change, Fixer for bounded multi-file work, Designer for UI/UX, Explorer for unfamiliar code, Librarian for research, and Oracle/Council for consequential decisions. Children run in isolated Pi JSON-mode subprocess contexts, with role tool allowlists; a child with `bash` is **not** sandboxed. Project trust is inherited, not automatically granted.

Completion is delivered at Pi's next safe tool boundary while the main agent is active, or starts a new turn when idle. The main agent should finish its current turn when no independent work remains; it should not call `sleep` or poll for results. The original OMP card continues to show progress. Cancelling a batch marks every unfinished task as cancelled in the card and retains completed results when a completion message is delivered.

The inline tool card shows each task's status from queued through completion. Hovering highlights the task row; click anywhere across that row to expand or collapse its full task text and the assistant replies recorded so far. Tool calls, tool results, and thinking are not shown in the card. There is **no OMP widget** or Ctrl+Alt+O popup. OMP does not integrate with `pi-subagents`; that third-party package is neither installed nor required. Child runs are isolated local processes, not Pi native session persistence, named session continuation, or resumable child sessions.

Recordings are persisted under `getAgentDir()/omp/conversations` (normally `~/.pi/agent/omp/conversations`) as local JSON event logs and metadata. Older recordings remain on disk. They can contain sensitive prompts, code, full tool arguments/results, and emitted thinking. Protect this directory, avoid sharing it, and delete old logs yourself when no longer needed: OMP does not automatically expire or purge them. Model-facing tool output is separately bounded/truncated; local logs retain the full recorded child-visible event data. Provider output may vary, and un-emitted content cannot be displayed.

The plugin UI and status/progress labels remain in **English**. Before each delegation or Council call, OMP makes **one extra call to the current main model** to infer the language from the **most recent user text on the current session branch** and translate the child role prompts and tasks for that request. Children are instructed to reply in that language; providers may still respond differently. Translation/validation errors fail closed (children are not started). The extra translation call's usage is included with child usage in the tool result, so budget for its cost.

See [references and boundaries](docs/references.md) for read-only upstream comparisons. Remove the GitHub installation with `pi remove git:github.com/hyird/oh-my-pi-slim`. Licensed under [MIT](LICENSE), retaining upstream attribution.
