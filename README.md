# Folder Pusher

A small Windows desktop app that copies one source folder to many destination machines on a LAN, with skip-existing semantics and per-destination reporting. The single-purpose tool version of the robocopy-loop we just ran by hand.

## What it should do

Given:
- **One source folder** (UNC path like `\\HOST\share\path\to\folder` or a local path).
- **A list of destination hostnames** (just the machine names, e.g. `KYPES-HQ`, `KYPES-HQ2`).
- **A destination path template** containing a `{machine}` placeholder, e.g. `\\{machine}\Users\Public\Music\Wes Montgomery`. The source folder name gets appended to this for each machine.

It should:
1. Verify the source path is reachable and report its size + file count up front.
2. For each destination, run `robocopy` with skip-existing semantics.
3. Stream per-destination progress to the UI.
4. Produce a summary table when done: machine, status, new files copied, elapsed seconds, exit code.
5. Be safely re-runnable — running it again should no-op on any machine that already has a complete copy.

## The copy engine — copy this verbatim

This exact `robocopy` invocation already works correctly for this use case. Use it.

```
robocopy <SRC> <DST> /E /XC /XN /XO /Z /R:2 /W:5 /MT:8 /NP /NDL /NJH /NJS
```

Flag meanings (don't change without thinking):
- `/E` — copy all subdirectories, including empty ones.
- `/XC /XN /XO` — combined, this means "skip any file that already exists at the destination, regardless of whether it's Changed, Newer, or Older." This is what "skip existing" means. Without all three, robocopy will overwrite older or newer files at the destination, which is **not** what we want.
- `/Z` — restartable mode. Useful on flaky LAN connections.
- `/R:2 /W:5` — retry twice, wait 5 seconds between retries. Defaults are 1 million retries with 30s waits, which means an unreachable destination hangs for hours. With `/R:2 /W:5`, unreachable destinations fail in about 10 seconds.
- `/MT:8` — multi-threaded copy. 8 threads is a good number for LAN gigabit.
- `/NP /NDL /NJH /NJS` — suppress per-file progress, directory list, job header, and job summary. Keeps stdout clean for parsing. If you want a chattier log, drop these.

### Exit codes — read this carefully

Robocopy's exit codes are not normal:

| Code | Meaning |
|------|---------|
| 0 | No files needed copying (everything already at destination). **Success.** |
| 1 | At least one file was copied. **Success.** |
| 2 | Extra files/dirs at destination. Not an error. |
| 3 | 1 + 2. **Success.** |
| 4 | Mismatched files/dirs. Investigate. |
| 5..7 | Combinations of 1, 2, 4. |
| 8 or higher | Real failure (couldn't copy something). |
| 16 | Serious error (usage error, etc.). |

**Treat any exit code < 8 as success.** Do not blindly trust `$LASTEXITCODE != 0` — that will incorrectly mark every successful copy as a failure. The PowerShell version of the script we just ran got bitten by this and reported "failed" even though every machine actually succeeded.

### Source-path note

A robocopy source argument is the **parent** of the files being copied, and the destination should also be a parent. So if the source folder is `\\HOST\share\path\Echoes Of Indiana Avenue`, the destination should be `\\OTHER\share\path\Echoes Of Indiana Avenue` (same trailing folder name), not just `\\OTHER\share\path`. Either compute that in the app or document it clearly in the UI.

## Recommended tech stack

**Electron + React + TypeScript.** Reasons:
- Spawns child processes (`child_process.spawn`) trivially, which is what we need for robocopy.
- Renderer can display live updates via IPC.
- You already have an Electron toolchain working (see `who-played-that-app` for reference).
- Cross-platform isn't a goal — this is Windows-only since robocopy is Windows-only.

Alternatives if you don't want Electron:
- **PowerShell + WinForms** — single .ps1 with a basic GUI. Zero install. Looks like the year 2003. Fine for personal use.
- **.NET 8 WinForms or WPF** — native Windows app, no Chromium. Larger learning curve if you're not already in .NET.
- **A plain CLI** — simplest. Skip the GUI entirely. `folder-pusher.exe --src "..." --machines KYPES-HQ,KYPES-HQ2,... --template "\\{machine}\..."`.

## UI sketch (Electron version)

A single window with three sections stacked vertically:

```
┌─ Folder Pusher ─────────────────────────────────────────────┐
│ Source: [\\KYPES-DOWNSTAIRS\...\Echoes Of Indiana Avenue]  📁 │
│         121.0 MB, 10 files                                   │
│                                                              │
│ Destination template:                                        │
│ [\\{machine}\Users\Public\Music\Wes Montgomery            ]  │
│                                                              │
│ Destinations (one per line):                                 │
│ ┌──────────────────────────────────────────────────────────┐ │
│ │ KYPES-HQ                                                  │ │
│ │ KYPES-HQ2                                                 │ │
│ │ KYPES-LEISURE                                             │ │
│ │ ...                                                       │ │
│ └──────────────────────────────────────────────────────────┘ │
│                                                              │
│                                          [ Copy to all ]    │
│                                                              │
│ ─── Progress ──────────────────────────────────────────────  │
│ ✅ KYPES-HQ        10 files  140s  rc=1                      │
│ ⏳ KYPES-HQ2       currently copying...                       │
│ ⬜ KYPES-LEISURE   queued                                     │
│ ⬜ ...                                                        │
└──────────────────────────────────────────────────────────────┘
```

## Edge cases the app must handle

- **Source not reachable**: show clear error, don't queue any copies.
- **Destination machine unreachable**: robocopy fails fast (~10s with `/R:2 /W:5`); mark that row as failed and continue to the next.
- **Destination machine reachable but path doesn't exist**: robocopy creates intermediate folders by default — good. But the parent share must exist.
- **Permission denied**: usually means the destination share has different ACLs than expected. Surface the robocopy error message in the row.
- **Concurrent invocations**: don't run more than one copy job at a time to avoid saturating the source machine's share I/O. UI should disable Copy while one is running.
- **Source modified during copy**: not a concern with skip-existing — if a new file appears partway through, it just gets picked up on the next run.

## Stretch goals (don't do these initially)

- **Profiles**: save named lists of destinations + path template (e.g., "All Kypes machines", "Just the upstairs ones").
- **Multiple sources**: queue several folders to push in one job.
- **Reverse direction**: pull from many to one (consolidation).
- **Drag-drop source**: drop a folder onto the window to set the source.
- **Auto-discovery**: walk Network Neighborhood to suggest destinations.
- **Per-destination logs**: collapsible log under each row showing the raw robocopy output.

## Reference: the exact PowerShell that worked

For reference, here's the PowerShell snippet that successfully copied the Wes Montgomery album to six machines. The Electron version should produce equivalent behavior, just with a UI on top and proper exit-code handling.

```powershell
$src = '\\KYPES-DOWNSTAIRS\Users\Public\Music\Wes Montgomery\Echoes Of Indiana Avenue'
$destMachines = @('KYPES-HQ','KYPES-HQ2','KYPES-LEISURE','KYPES-LEISURE2','KYPES-LIVING-RM','KYPES-ROOM')
foreach ($m in $destMachines) {
  $dst = "\\$m\Users\Public\Music\Wes Montgomery\Echoes Of Indiana Avenue"
  Write-Host "=== $m ==="
  robocopy $src $dst /E /XC /XN /XO /Z /R:2 /W:5 /MT:8 /NP /NDL /NJH /NJS
  $rc = $LASTEXITCODE
  $status = if ($rc -lt 8) { 'OK' } else { 'FAILED' }
  Write-Host "$m: rc=$rc ($status)"
}
```

Six destinations × 121 MB took ~13.5 minutes total (sequential). A parallel version would saturate the source share's I/O and likely be slower, not faster.

## Naming

Pick whatever, but the placeholder name is **Folder Pusher**. Other candidates: `LAN Copy`, `Mirror Many`, `Branch Copy`, `Share Pusher`. The repo folder is currently `folder-pusher`.
