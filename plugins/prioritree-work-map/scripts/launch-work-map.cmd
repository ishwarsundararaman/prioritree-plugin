@echo off
setlocal EnableExtensions DisableDelayedExpansion
set "NODE_EXE="
if defined CODEX_MCP_NODE_PATH if exist "%CODEX_MCP_NODE_PATH%" if not exist "%CODEX_MCP_NODE_PATH%\" set "NODE_EXE=%CODEX_MCP_NODE_PATH%"
if defined NODE_EXE goto run
for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if defined NODE_EXE goto run
if defined USERPROFILE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE_EXE goto run
if defined HOME if exist "%HOME%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" set "NODE_EXE=%HOME%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if defined NODE_EXE goto run
>&2 echo PrioriTree needs Node.js 20.19 or newer. Install Node.js LTS and restart your host, or use Codex with its bundled Node runtime.
exit /b 1
:run
"%NODE_EXE%" "%~dp0..\server\work-map.mjs" %*
exit /b %ERRORLEVEL%
