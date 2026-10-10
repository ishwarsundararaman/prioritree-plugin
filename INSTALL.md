# Install PrioriTree

PrioriTree turns your local Codex chats into a work map: businesses, departments, initiatives and
steps. What you decide is kept separate from what the AI claims. You don't need a desktop app, a
source checkout or `npm install`.

## Claude Desktop

1. Download `prioritree.mcpb` from the
   [latest release](https://github.com/ishwarsundararaman/prioritree-plugin/releases/latest).
2. Open the file in Claude Desktop and click **Install**. You can also go to Settings →
   Extensions → Advanced settings → Install Extension and select the file. You don't need to
   install anything else. PrioriTree's background engine uses Codex's Node runtime or Node.js on
   your PATH when either is available. Otherwise, the map builds and updates while Claude Desktop
   is open.
3. Start a new chat and say **work map**.

## Codex desktop app or CLI

```text
codex plugin marketplace add ishwarsundararaman/prioritree-plugin
codex plugin add prioritree-work-map@prioritree
```

Then start a new chat and say **work map**. The plugin uses the Node runtime that Codex supplies.

## Claude Code

```text
/plugin marketplace add ishwarsundararaman/prioritree-plugin
/plugin install prioritree-work-map@prioritree
```

Start a fresh session if the tools don't appear. Claude Code needs Node.js 20.19 or newer on your
PATH.

## First run

1. **Say "work map".** The map opens straight away, inside the chat in apps that show panels, or
   in a local desk window otherwise.
2. **It builds itself, biggest project first.** It reads your local Codex chats from the last 14
   days and summarises each one with your own Codex. Installing and invoking the plugin authorizes
   this reading.
3. **Move around the map.**
   - Click a card to go deeper and use the up arrow to come back.
   - Hover for a short description; click for the full details.
   - Drag cards to reorder, double-click a name to rename it, and use **+ Add** to add a task.
   - For anything else, such as accepting a step, pausing or approving, just say it in the chat.
4. **Alerts and updates.**
   - A red ⚠ appears only when work is waiting on something only you can do. It tells you exactly
     what to do.
   - Progress goes to the quiet bell.

## Keeping the map current

PrioriTree's local engine starts on its own when Claude Desktop or Codex uses the plugin. It builds
the whole map by itself, and the chat you started it from doesn't need to stay open. If it's
interrupted, it picks up where it left off.
- **Changed chats:** it notices them and re-reads each one about two minutes after it goes quiet,
  using your own Codex.
- **Morning update:** it does one at 07:00, or at the first start after 05:00 if your computer was
  off.
- **Your chats are untouched:** it never resumes, writes to or sends anything in your chats.

## Where things are stored

| System | Folder |
|---|---|
| Windows | `%USERPROFILE%\.prioritree\work-visibility` |
| macOS | `~/Library/Application Support/PrioriTree/work-visibility` |
| Linux | `$XDG_DATA_HOME/PrioriTree/work-visibility`, or `~/.local/share/PrioriTree/work-visibility` |

- **What's there:** the map (`snapshot.json`), its append-only history (`history.jsonl`), and
  `diagnostics.log`. The log records request types, outcomes and timings, never chat content, and
  rotates at about 1 MB.
- **Moving it:** set `PRIORITREE_WORK_STORE_DIR` to use a different folder.
- **Uninstalling:** keep the folder if you want your map back later.
- **Earlier versions:** on first open, a map from an earlier version is copied into the new folder
  automatically. The old copy is left untouched.

## Good to know

- **Sources:** only Codex chats are read today. Claude's own chats aren't read yet.
- **Platforms:** automated checks run the installed plugin on Windows, Mac and Linux for every
  release, in Claude Desktop, Codex and Claude Code.
- **No cloud:** there is no PrioriTree cloud sync in this version. Your map stays on your computer.
  Your AI provider processes the chat text it summarises, under its own terms.

Questions or problems: open an [issue](https://github.com/ishwarsundararaman/prioritree-plugin/issues)
or write to support@unsolved.network.
