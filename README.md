# PrioriTree

**See all your AI work as one map.** PrioriTree reads the chats you run with your AI and organizes
them into businesses → goals → initiatives → steps. For each piece of work it shows what's done, what's
left, where it's stuck and what's waiting on you.

Your AI can say a step is done. Only you can accept it.

## Install

**Claude Desktop** (Windows or Mac):

1. Download `prioritree.mcpb` from the
   [latest release](https://github.com/ishwarsundararaman/prioritree-plugin/releases/latest).
2. Open the file and click **Install**.
3. A small PrioriTree window opens. Click **Build my map**. The map fills in as it reads your chats,
   biggest project first. If the window doesn't appear, start a new chat and say **PrioriTree**.

**Codex** (verified on Windows):

```
codex plugin marketplace add ishwarsundararaman/prioritree-plugin
codex plugin add prioritree-work-map@prioritree
```

**Claude Code:**

```
/plugin marketplace add ishwarsundararaman/prioritree-plugin
/plugin install prioritree-work-map@prioritree
```

Then start a new chat and say **PrioriTree**. The first time, a small window also opens with one
button: **Build my map**.

## What you get

- **One map of your work.** Each initiative has a clear goal, where it stands, what's next, and how
  much of your attention it's taking (based only on messages you typed).
- **Red alerts only when you're the blocker.** Each one says exactly what to do, why the work is
  stuck, and what happens after. Progress goes to a quiet bell.
- **It stays current by itself.** Changed chats are re-read shortly after they go quiet, and there's
  a morning update.
- **You stay in charge.** Drag to reorder, rename in place, add tasks, or just say what you want in
  the chat. The AI can say a step is done; only you can accept it.

## What it reads, and where it keeps things

- **Reads:** your local Codex chats from the last 14 days. Only your own AI reads them, inside your
  own subscription. Support for Claude chats is coming next.
- **Stores:** the map lives on your computer. On Windows that's `%USERPROFILE%\.prioritree`.
  Nothing is uploaded.

Details and troubleshooting are in [INSTALL.md](INSTALL.md).

## Privacy Policy

The plugin and desk run on your computer and keep your map there. Optional online features store a copy of the map on our servers only if you turn them on. Read the full [Privacy Policy](PRIVACY.md). Questions: support@unsolved.network.

## Status

This is an early release (1.13.6). Automated checks run the installed plugin on Windows, Mac
(Apple silicon and Intel) and Linux for every release: Claude Desktop, Codex and Claude Code.

Feedback is welcome in [Issues](https://github.com/ishwarsundararaman/prioritree-plugin/issues).
