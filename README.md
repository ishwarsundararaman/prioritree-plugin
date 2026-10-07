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
3. In a new chat, say **Map my work**, then **Open my work map**. The map appears inside the chat.

**Codex** (Windows today):

```
codex plugin marketplace add ishwarsundararaman/prioritree-plugin
codex plugin add prioritree-work-map@prioritree
```

**Claude Code:**

```
/plugin marketplace add ishwarsundararaman/prioritree-plugin
/plugin install prioritree-work-map@prioritree
```

Then start a new chat and say **Map my work**.

## What it reads, and where it keeps things

- **Reads:** your local Codex chats from the last 14 days. Only your own AI reads them, inside your
  own subscription. Support for Claude Code chats is coming next.
- **Stores:** the map lives on your computer. On Windows that's `%LOCALAPPDATA%\PrioriTree`. Nothing
  is uploaded.
- **Nothing to read yet?** Say **Try with sample data** to see a sample map.

Details and troubleshooting are in [INSTALL.md](INSTALL.md).

## Status

This is an early release. It has been verified on Windows. Mac support and the in-chat panel in each
app are still being checked. Feedback is welcome in
[Issues](https://github.com/ishwarsundararaman/prioritree-plugin/issues).
