# dsh-portable-kit

**Build a truly portable DeepSeek Harness — one folder you can copy to a USB stick, snapshot in 30ms, and roll back the moment a bad plugin breaks it.**

[中文文档](./README_CN.md)

```bash
# Linux / macOS
./build.sh && cd out/DSH-Portable-linux-x64 && ./start
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\build.ps1
cd out\DSH-Portable-win-x64 ; .\start.cmd
```

No Node. No Rust. No `sudo`. Nothing installed on your system.

---

## The problems this solves

DSH is powerful but leans hard on plugins, and plugin quality varies wildly. Three
things go wrong in practice, and each one has a concrete fix here.

### 1. A bad plugin bricks your setup, and backups are too slow to bother with

Backing up a 2.2 GB install takes minutes, so nobody does it "just in case" — and
that's exactly when you need it.

**Fix: layered snapshots.** Only archive what can't be rebuilt — sessions, settings,
credentials, the plugin manifest, your workspace. `node_modules` stays out, because
it rebuilds offline from the in-folder pnpm store.

```
./dsh-snap before-risky-plugin    # measured: 28KB, 0.03s
./dsh-restore before-risky-plugin # measured: 562ms, deps rebuilt offline
```

Snapshots are also **automatic**: any `dsh plugin add/remove/update` takes one first.
The last 10 are kept; manually named ones are never pruned.

### 2. "Portable" builds break the moment you move them

pnpm's default layout creates tens of thousands of symlinks and writes absolute
paths into `.modules.yaml`. Copy the folder and it's dead.

**Fix: a measured, enforced portability recipe.**

| Problem | Fix | Measured result |
|---|---|---|
| pnpm symlink farm | flat npm install for the runtime | 453 packages → 12 symlinks, all relative |
| Plugins still use pnpm | `pnpm_config_node_linker=hoisted` via **env**, not `.npmrc` | profile symlinks 87 → 1 |
| pnpm store escapes the folder | `pnpm_config_store_dir` → in-folder | store travels with the build |
| `fs.cp` silently rewrites relative symlinks to absolute | `verbatimSymlinks: true` | caught in testing — 19 broken links |

The build **fails hard** if any absolute symlink survives (`verifyPortable()`), so
this can't silently regress.

Verified by actually moving a build: copied to a different path, `./dsh --version`
works, `DSH_HOME` follows, plugins install in 895ms, layout stays hoisted.

### 3. You wait on someone else to ship the version you want

`@deepseek-ai/dsh` is a plain npm package, but community portable builds pin it and
you wait for the maintainer.

| Route | Middleman | Measured lag |
|---|---|---|
| WSL043/DSH-Portable | manual lockfile bump + 3-platform QA | days |
| hairyf desktop | automated repackaging repo | 6–13 hours |
| **this builder** | **none — straight from npm** | **zero** |

```bash
npm view @deepseek-ai/dsh dist-tags
./build.sh -d next          # build it the moment it publishes
./build.sh -d 0.1.0-rc.7    # roll back; npm keeps every version forever
```

Dist-tags resolve to concrete versions before caching, so `-d next` genuinely
rebuilds when upstream publishes instead of silently reusing a stale tree.

---

## Quick start

```bash
# Linux / macOS
./build.sh

# Windows
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

Then:

```bash
cd out/DSH-Portable-linux-x64
./start          # starts the server, opens a dedicated browser window
```

### Requirements

| Host | Needs |
|---|---|
| Linux | `curl`, `tar` (plus `bsdtar` **or** `unzip` for Windows targets — most distros ship one) |
| macOS | `curl`, `tar` — both preinstalled |
| Windows | PowerShell 5.1+ — preinstalled on Win10/11. Builds Windows targets only, see [Cross-building](#cross-building) |

Node.js is downloaded and SHA256-verified by the builder. Nothing is installed
system-wide; the toolchain lives in `.toolchain/`.

## Usage

Flags go on the entry script — `build.sh` on Linux/macOS, `build.ps1` on Windows.
Both hand them to `lib/build.mjs` verbatim, so the spelling is identical on every
platform. Use the long/short forms below, *not* PowerShell-style `-Targets`.

| Flag | Description |
|---|---|
| `-t, --targets <list>` | Comma-separated targets, or `all`. Defaults to host |
| `-d, --dsh-version <ver>` | `latest` / `next` / `0.1.1-rc.1`. Default `latest` |
| `--pnpm-version <ver>` | pnpm version (default `11.7.0`) |
| `--node-version <ver>` | Node version (default `v24.19.0`) |
| `--registry <url>` | npm registry |
| `--node-mirror <url>` | Node download mirror |
| `--cn` | Shortcut for npmmirror — read by the bootstrap *and* `build.mjs` |
| `--libc <glibc\|musl>` | libc for Linux targets (default `glibc`) |
| `-o, --out <dir>` | Output directory (default `./out`) |
| `--fresh` | Ignore the cached runtime tree and reinstall |

Targets: `linux-x64` `linux-arm64` `darwin-x64` `darwin-arm64` `win-x64` `win-arm64`

```bash
# Linux / macOS
./build.sh -t all                              # every platform
./build.sh -t linux-x64,win-x64 -d 0.1.1-rc.1
./build.sh --cn                                # China mirrors
```

```powershell
# Windows — everything after .\build.ps1 goes to the builder;
# -ExecutionPolicy and -File belong to powershell.exe itself
powershell -ExecutionPolicy Bypass -File .\build.ps1 -t win-x64 -d 0.1.1-rc.1
powershell -ExecutionPolicy Bypass -File .\build.ps1 --cn
```

### Mirrors

`--cn` points the registry, the target Node runtime **and** the bootstrap host Node at
npmmirror:

```bash
./build.sh --cn
```

The bootstrap scripts parse `--cn` themselves, which they have to: they must fetch the
host Node *before* there is a Node to parse `--cn` with. That is also the single largest
download in the build (50–90 MB), so skipping it would make the flag close to pointless.

Environment variables override `--cn`:

| Variable | Applies to | Default |
|---|---|---|
| `DSH_BUILD_NODE_MIRROR` | **bootstrap** — host Node download | `https://nodejs.org/dist` |
| `DSH_BUILD_REGISTRY` | npm registry (same as `--registry`) | `https://registry.npmjs.org/` |
| `DSH_BUILD_NODE_VERSION` | pinned Node version | `v24.19.0` |

Mirrors don't weaken verification — `SHASUMS256.txt` is still fetched and every archive
checked, with a mismatch deleting the download and aborting. npmmirror's copy is
byte-identical to the nodejs.org one (verified), and its dist-tags are in sync.

## What you get

```
DSH-Portable-<target>/
├── start / start.cmd        launch server + dedicated browser window
├── dsh / dsh.cmd            CLI passthrough (auto-snapshots plugin changes)
├── pnpm / pnpm.cmd          pnpm shim
├── dsh-snap / dsh-snap.cmd  snapshot
├── dsh-restore(.cmd)        roll back
├── launcher/snapshot.mjs    snapshot logic (shared by both platforms)
├── runtime/node/            pinned Node
├── app/node_modules/        DSH kernel + pnpm + this platform's native variants
├── data/
│   ├── dsh-home/            $DSH_HOME — sessions, settings, credentials, plugins
│   ├── pnpm-store/          offline rebuild source for plugins
│   └── browser/             dedicated browser profile
├── workspace/               default workspace
├── snapshots/
└── VERSION.json
```

Copy it, move it, put it on a USB stick. Every path is resolved at launch from the
script's own location.

## Plugins

Plugins install into the profile directory and travel with the folder:

```
data/dsh-home/profiles/web/
├── package.json          what's installed
├── pnpm-lock.yaml        pinned versions
├── pnpm-workspace.yaml   generated by pnpm — records nodeLinker: hoisted
└── node_modules/         the plugins themselves
```

```bash
./dsh plugin --profile web add <plugin>
./dsh plugin --profile web list --depth 0
./dsh plugin --profile web update <package>
./dsh plugin --profile web remove <package>
```

For local plugins use a **relative** path so the link survives a move:

```bash
./dsh plugin --profile web add link:../../../workspace/my-plugin
```

> `dsh plugin` forwards to pnpm, and `@deepseek-ai/dsh` does not bundle pnpm.
> This builder ships it — without that, plugin management simply doesn't work.

## Snapshots

**Automatic** before any mutating plugin command, and **manual** whenever you want.

```bash
./dsh-snap                      # timestamped
./dsh-snap clean-baseline       # named — never auto-pruned
./dsh-snap --list
./dsh-restore clean-baseline    # no argument lists available snapshots
```

| Included | Excluded |
|---|---|
| `sessions/`, `settings.yaml`, `.credentials.yaml` | `profiles/*/node_modules` (rebuilt offline) |
| `profiles/*/package.json`, `pnpm-lock.yaml` | `logs/` |
| `workspace/` | `runtime/`, `app/` |

### Retention

Auto snapshots are named `auto-<timestamp>`; the newest 10 are kept and older ones
pruned on each new snapshot. **Manually named snapshots are never pruned.**

```bash
DSH_SNAPSHOT_KEEP=30 ./dsh plugin --profile web add foo   # keep more
DSH_AUTO_SNAPSHOT=0  ./dsh plugin --profile web add foo   # skip auto-snapshot
```

Stop DSH before restoring.

## Platform support

✅ Linux x64/arm64 (glibc) · Windows x64/arm64 · macOS x64/arm64

Those are the *targets*. Which of them a given machine can build is a separate
question — see [Cross-building](#cross-building).

Only 6 of DSH's 453 dependencies are platform-bound, all using the
optionalDependencies variant pattern:

| Family | Linux x64 | Linux arm64 | Win x64 | Win arm64 | macOS arm64 | musl | armv7 |
|---|---|---|---|---|---|---|---|
| koffi | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ❌ |
| sharp | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| @vscode/ripgrep | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| node-addon-require-builtin | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| landlock-run | ✅ | ✅ | — | — | — | — | — |

**Not supported:** armv7, Alpine/musl. Prebuilt `.node` binaries also carry a minimum
glibc requirement, so very old distros (CentOS 7) may still fail — untested.

## How it works

```
detect os/arch → download + verify Node → install "fat tree" → prune per target
              → assemble → portability self-check
```

The **fat tree**: install the official package, scan for `os`/`cpu`/`libc` fields,
walk the parents' `optionalDependencies` to find every sibling variant, then
`npm install --force` to pull all platforms into one tree. Each target gets a copy
with incompatible variants pruned. Targets share one download; the tree is cached
in `.cache/`.

### Why no Rust

DSH itself is a pure npm package — Rust is only needed for a Tauri native shell.
This builder uses browser app-mode as the window, which is also what DSH-Portable
falls back to. That avoids rustc, webkit2gtk, and the genuinely hard part:
cross-compiling Tauri (macOS targets need the Apple SDK, Windows needs MSVC).

### Why sh + ps1 instead of Python

The bootstrap's only job is getting Node onto a machine that has nothing. So the
only question that matters is whether the interpreter ships with the OS:

| | Linux | macOS | Windows | Zero prerequisites |
|---|---|---|---|---|
| POSIX sh | ✅ | ✅ | ❌ | yes |
| PowerShell | ❌ | ❌ | ✅ Win10+ | yes |
| Python | ⚠️ often absent in slim containers | ⚠️ no bundled py3 | ❌ not installed | **no** |

Python isn't guaranteed on *any* of the three. Meanwhile only the ~90-line bootstrap
is duplicated — `lib/build.mjs` holds all real logic and is already cross-platform.

### External commands

| Purpose | Dependency |
|---|---|
| extract `.tar.gz` | `tar` (all three platforms) |
| extract `.zip` | `tar` on Windows/macOS (it is bsdtar); `bsdtar` or `unzip` on Linux |
| directory sizes | none — computed in Node |

## Cross-building

A POSIX host can build every target. A Windows host can only build Windows targets.

| Host ↓ / Target → | `linux-*` | `darwin-*` | `win-*` |
|---|---|---|---|
| Linux | ✅ | ✅ | ✅ |
| macOS | ✅ | ✅ | ✅ |
| Windows | ❌ refused | ❌ refused | ✅ |

The asymmetry is NTFS, not laziness. Two things break when a Windows host targets
POSIX, and neither can be worked around from the shelled-out tools:

- **No executable bit.** `fs.chmod` on Windows only toggles the read-only attribute,
  NTFS has no concept of one, so every file in the staged folder ends up `0644` —
  even `runtime/node/bin/node` is `Permission denied` once it reaches a POSIX box.
- **No symlinks.** `bin/npm`, `bin/npx` and `bin/corepack` in the official Linux and
  macOS Node tarballs are symlinks, which an unprivileged Windows process cannot
  create. The builder repairs these by copying the link target's contents (they are
  `#!/usr/bin/env node` scripts, so a copy behaves identically) — but that only fixes
  extraction, not the executable bit above.

Such a build would exit 0 and fail only when someone tries to *use* the folder, so
the builder refuses it up front instead. Build POSIX targets on a POSIX host — WSL
is enough:

```bash
wsl -- sh ./build.sh -t linux-x64
```

Cross-building the other way is fully supported: a Linux host produces a Windows
package that runs unmodified, `.bin/` aside (see below).

`app/node_modules/.bin` always carries the *host's* shim flavour — symlinks from a
POSIX host, `.cmd`/`.ps1` from Windows. It is vestigial: the launchers invoke
`lib/bin.js` and `pnpm.cjs` by path, and `PATH` gets the package root rather than
`.bin`. Deleting `.bin` entirely leaves `dsh`, `pnpm` and `dsh plugin` working, so a
cross-built package is unaffected.

## Security note

`data/dsh-home/.credentials.yaml` holds **plaintext** API credentials. Losing the
USB stick means losing the credentials. Encrypt it before putting the folder on
removable media, or exclude it and re-authenticate on the new machine.

## Known limitations

- exFAT/FAT32 USB sticks don't support symlinks. The remaining links are all `.bin/`
  CLI shims; DSH invokes `node .../lib/bin.js` directly, so nothing breaks.
- Windows hosts can only build Windows targets — see [Cross-building](#cross-building).
- Moving between Linux and Windows requires building both targets.
- Upstream adaptation risk is yours — no third party vets a new DSH release for you.
  Snapshot before upgrading.

## Test status

### Linux host — Arch x86_64, `-t linux-x64,win-x64`

| Check | Result |
|---|---|
| Bootstrap Node + SHA256 | ✅ |
| Native pruning | linux keeps 6/drops 55 · win keeps 4/drops 57 |
| Portability self-check | linux 19 links · win 16 — all relative |
| `./dsh --version` after moving | ✅ `0.1.0-rc.8` |
| Plugin install after moving | ✅ 895ms, hoisted, 1 symlink |
| Auto-snapshot on plugin change | ✅ fires; `DSH_AUTO_SNAPSHOT=0` disables |
| Retention | ✅ 10 auto kept, manual preserved |
| `./dsh-restore` | ✅ deps rebuilt offline, 331ms |
| Web server | ✅ HTTP 200, `<title>DeepSeek Harness</title>` |

### Windows host — Windows 11 x64, PowerShell 5.1, `-t win-x64`

| Check | Result |
|---|---|
| `build.ps1` bootstrap + SHA256 | ✅ |
| Flag passthrough | ✅ `-t` `-d` `-o` `--targets` all reach `build.mjs` |
| npm install | ✅ 451 packages in 20m (Defender scanning dominates) |
| Native pruning | ✅ keeps 4/drops 55 |
| Portability self-check | ✅ 0 symlinks — npm emits `.cmd`/`.ps1` shims on Windows |
| `dsh.cmd --version` | ✅ `0.1.0-rc.7` |
| `pnpm.cmd --version` | ✅ `11.7.0` — the bundled one, not a global install |
| `dsh-snap.cmd` create/list | ✅ |
| POSIX targets | ✅ refused up front (see [Cross-building](#cross-building)) |

### Cross-build: Linux host → Windows target, verified on real Windows

The folder produced by `./build.sh -t win-x64` on Arch, copied to Windows 11:

| Check | Result |
|---|---|
| `.cmd` line endings | ✅ 32 CRLF, 0 bare LF |
| `dsh.cmd --version` | ✅ `0.1.0-rc.7` |
| `pnpm.cmd --version` | ✅ `11.7.0` |
| `dsh.cmd plugin list` | ✅ forwards to pnpm, initialises the profile |
| Pruning correctness | ✅ kept exactly the four `win32-x64` natives |
| Web server | ✅ HTTP 200, `<title>DeepSeek Harness</title>` |
| `.bin` flavour | ⚠️ 16 dereferenced symlinks, no `.cmd` — unused, nothing breaks |

**Untested:** macOS on real hardware; arm64 targets on real hardware; `start.cmd`'s
browser-launch path (the server itself is covered above).

## Related

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — upstream DSH
- [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) — community portable build with a Tauri shell
- [hairyf/deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop) — Tauri desktop app
- [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable) — Windows portable build

## License

MIT. DeepSeek Harness and its name and logo belong to DeepSeek; this project is a
packaging wrapper around the official npm release and is not an official artifact.
