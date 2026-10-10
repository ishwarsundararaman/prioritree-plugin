# Installed plugin checks

These checks exercise the public bundles with Node built-ins. They do not import the
private source, install product dependencies, use AI models, or read a personal profile.
Every product run gets separate temporary HOME, USERPROFILE, APPDATA, LOCALAPPDATA,
CODEX_HOME and XDG directories. The default store override is unset. The source is one
synthetic Codex session served by a read-only app-server helper.

The workflow runs Node 20 and 22 on Apple silicon macOS (`macos-latest`), Intel macOS
(`macos-15-intel`), Linux and Windows. These are standard free public-repository runners;
labels were checked on 2026-10-10 against the
[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
Electron 44.7.0 runs once per OS, in the Node 22 job; Electron supplies its own runtime,
so changing the controller's Node version would not test a different Electron runtime.

## Launch contract

| Host | Declared command | Runtime selection |
| --- | --- | --- |
| Codex | `.codex-plugin/plugin.json` references `.mcp.json`: `cmd.exe /d /c scripts\launch-work-map.cmd codex`, cwd plugin root | `CODEX_MCP_NODE_PATH` first, then PATH and bundled-runtime fallback |
| Claude Code | `.claude-plugin/plugin.json` references `.mcp.json`: `${CLAUDE_PLUGIN_ROOT}/scripts/launch-work-map.cmd claude` | PATH first, then `CODEX_MCP_NODE_PATH` and bundled-runtime fallback |
| Claude Desktop MCPB | `manifest.json` server `mcp_config.command` and `args`; Node or a real Electron binary with `ELECTRON_RUN_AS_NODE=1` | The host's supplied executable |

The `.cmd` launchers are executable polyglot scripts: a POSIX shell dispatches to `.sh`,
while cmd.exe uses the batch section. The POSIX configurations instead declare `sh
scripts/launch-work-map.sh codex/claude`; Claude's Windows variant explicitly declares
`cmd.exe /d /c`. The checks load the manifest's actual referenced configuration and also
test the platform variants. They never silently substitute an unreferenced POSIX file.
The package builder has no OS-selection rule for these alternate files. In 1.13.3 the
Codex default still says `cmd.exe` on macOS/Linux, which is expected to fail there.

## Evidence

1. Parse every shipped manifest/configuration; compare marketplace, plugin, MCPB and
   bundle versions; verify referenced launchers, icons, skills, server and desk files.
   Read git's index to require `100755` shell-launcher modes.
2. Run the host command, initialize MCP, list every declared real-mode tool, read the
   work-map HTML resource, scan the synthetic session and call `get_mapping_rules`.
   `try_sample_map` is fixture-only, so real-mode checks use a model-free real tool.
3. Require the documented default store and reject additional work-visibility stores
   in the isolated profile. Linux also checks the default when XDG_DATA_HOME is unset.
4. Call real-mode `open_desk`; require matching version health and the desk HTML/scripts
   within 60 seconds. Send the same-origin desk Stop request, then verify the engine's
   exact birth identity exited and its chosen port is closed and bindable. Ports 47731
   and 47732 are never used. Close MCP stdin and verify captured descendants exited.
   Recovery termination cannot turn a failing Stop check into a pass.
5. Run the same MCPB entry under genuine Electron. Require a healthy engine or explicitly
   reported in-process fallback, a scan that advances or reports a clear error, and no
   file anywhere in the store whose size and SHA256 match the Electron executable.
   The Windows 1.13.3 copy-as-node.exe regression must fail this check.
6. On published releases/manual runs, download the latest `prioritree.mcpb`, check its
   release tag, asset size/digest and manifest version, safely extract it, and run the
   Node and Electron checks against its own server files.
7. Keep bounded diagnostics, snapshots, engine ownership records and host stderr after
   shutdown. Upload them on failure for three days. Do not upload staged binaries or
   dependency caches. Temporary product profiles are removed only after cleanup proof.
   A diagnostic-only Node preload copies the engine's otherwise-discarded output into
   a bounded log; it preserves the executable, launch arguments and process behavior.

## Local commands

Run one command at a time. Select a Node runtime whose version you want to test:

```text
node --test .github/scripts/check-support.test.mjs
node .github/scripts/check-plugin.mjs --artifacts <temporary-diagnostics-directory>
node .github/scripts/check-support.mjs install-electron <temporary-electron-directory>
node .github/scripts/check-plugin.mjs --phase electron --electron <electron-executable> --artifacts <temporary-diagnostics-directory>
node .github/scripts/check-support.mjs lint <temporary-linter-directory> .github/workflows/checks.yml
```

`electron-install.json` records the installed executable path. `--manifest-only` checks
metadata without starting product processes. `--layout mcpb --root <extracted-asset>`
checks an extracted release. Each run's `owner.json` records PIDs, OS birth identities,
commands, purpose, Stop route, exit verification, port release and generated bytes.
`summary.json` contains concise verdicts. Delete the task's Electron/linter installation
only after its processes have exited and review evidence has been retained.

These checks verify declared launch commands, not the host apps' installer/discovery UI.
Real Mac execution and workflow acceptance remain pending until the reviewer pushes
the branch and inspects GitHub Actions. A local commit is not a publication.
