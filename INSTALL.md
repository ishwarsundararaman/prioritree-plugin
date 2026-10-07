# Install PrioriTree

PrioriTree turns your local Codex chats into a work map: businesses, goals, initiatives and steps,
with the user's decisions kept separate from AI claims. One bundled server serves all three hosts.
You do not need the PrioriTree desktop app, a source checkout, or an `npm install` after installing.


## Codex desktop app or CLI

Run these commands in a terminal:

```text
codex plugin marketplace add ishwarsundararaman/prioritree-plugin
codex plugin add prioritree-work-map@prioritree
```

Then start a new chat. The plugin uses Codex's supplied Node runtime. If your host has not supplied
`CODEX_MCP_NODE_PATH`, update the host or use the documented alternate launcher configuration in
the release package. Do not hardcode another user's Node path.

The generated Codex marketplace currently selects the Windows launcher. For a macOS/Linux release,
the release owner must select `plugins/prioritree-work-map/.mcp.posix.json` as that package's
`.mcp.json` **before publishing the Git source**. This uses `sh` and the same host Node. A single
automatic OS-selecting Codex configuration has not been established by the host's documented
format; do not advertise the default Windows Git tree as verified on macOS/Linux.

## Claude Code

In Claude Code, run:

```text
/plugin marketplace add ishwarsundararaman/prioritree-plugin
/plugin install prioritree-work-map@prioritree
```

Restart Claude Code or start a fresh session if the new tools are not visible. Claude Code does not
provide a Node runtime for this plugin: the launcher checks `node` on PATH, then Codex's bundled
Node. If neither exists, install Node.js 22.12 or newer, reopen Claude Code so its PATH updates,
and retry. You do not need to install server dependencies.

The Claude launcher includes Windows and POSIX bodies. A release owner must preserve its executable
Git mode for macOS/Linux. Explicit `.mcp.windows.json` and `.mcp.posix.json` variants are included
for hosts that cannot launch the combined script directly. Native installs on these systems remain
unverified; the Windows launcher and POSIX shell logic are checked using temporary fake runtimes.

## Claude Desktop

Download `prioritree.mcpb` from the [latest release](https://github.com/ishwarsundararaman/prioritree-plugin/releases/latest). Open it in Claude Desktop and approve the
extension's local access when prompted. You can also use Settings → Extensions → Advanced settings
→ Install Extension to select the file. Enable the extension and start a new conversation.
Claude Desktop supplies Node for a `node` extension; no separate Node installation is needed.
Do not unzip it into your host's configuration folders.

## First run

1. Say **Map my work**. In a host with a prompt picker, choose PrioriTree's **Map my work** prompt;
   in Codex or Claude Code, the `work-map` skill carries the same workflow.
2. The AI explains that it will read your local Codex projects and the chats active in the last
   14 days, then asks for your OK. After you agree, it groups the evidence, proposes goals and
   initiatives, and measures your own messages as attention.
3. Say **Open my work map**. In a host that renders MCP Apps, `open_work_map` supplies the panel
   inside the chat. Rank goals, correct misplaced initiatives, and accept or reject steps there.
   AI completion reports are only claims until you accept them.

If no supported local Codex source is available, PrioriTree explains what is missing and offers
**Try with sample data**. Say that phrase to run `try_sample_map`. The sample is clearly labelled,
stays in memory, and never replaces your saved map. Restart the plugin session to return to real
data. Starting the bundled server with `--fixture` also selects the sample.

Only Codex history is supported today. Installing in Claude does not make Claude's own chats
available. Install Codex locally if you want to map its history. For a nonstandard installation,
set `PRIORITREE_CODEX_CLI` to the absolute Codex executable or its `codex.js` CLI entry; an explicit
invalid path produces the explanation rather than silently selecting a different source.

Panel rendering and the real host install flows still need human verification. If a host cannot
render MCP Apps, its model tools can give a text summary; try Claude Desktop or a Codex host with
MCP Apps support for the panel. This plugin does not start a local web server.

## Local access and storage

The server reads local Codex project/chat metadata and, during setup or an evidence request, chat
messages through a read-only Codex app-server client. It never resumes a chat or starts a model
turn in the source. It may read Codex's saved project assignments to recover older membership.
It does not read Claude history, change Codex/Claude configuration, install another plugin, or
send your map to a PrioriTree cloud service.

The AI host receives the chat text returned by setup tools and applies its own data policy.
The map's local storage does not make the host's AI processing offline.

On Windows, the saved map and append-only change history are in
`%LOCALAPPDATA%\PrioriTree\work-visibility` (`snapshot.json`, `history.jsonl`, and brief journal/lock
files while writing). With no `LOCALAPPDATA`, the current default is
`~/AppData/Local/PrioriTree/work-visibility`, including on macOS/Linux. Set
`PRIORITREE_WORK_STORE_DIR` in the server environment to choose another directory. Keep that
directory when uninstalling if you want to recover your map later. Sample mode writes no store.

There is no cloud sync, background refresh worker, or desk engine in this package.

## For release reviewers

Run `npm run build:plugin` from this app checkout to produce the unpublished release tree and
desktop extension. Run `node scripts/probe-plugin.mjs` for the isolated stdio check. The probe
copies only the bundled server into a temporary directory, sets a temporary store and absent
Codex source, and closes and verifies its child processes. Do not install into a real host as
part of this task. See [the handoff](handoffs/PLUGIN-2026-10-07.md) for exact checks and format sources.
