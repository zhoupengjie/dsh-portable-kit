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
| Linux | `curl`, `tar` (plus `unzip` to build Windows targets) |
| macOS | `curl`, `tar` — both preinstalled |
| Windows | PowerShell 5.1+ — preinstalled on Win10/11 |

Node.js is downloaded and SHA256-verified by the builder. Nothing is installed
system-wide; the toolchain lives in `.toolchain/`.

## Usage

| Flag | Description |
|---|---|
| `-t, --targets <list>` | Comma-separated targets, or `all`. Defaults to host |
| `-d, --dsh-version <ver>` | `latest` / `next` / `0.1.0-rc.8`. Default `latest` |
| `--pnpm-version <ver>` | pnpm version (default `11.7.0`) |
| `--node-version <ver>` | Node version (default `v24.19.0`) |
| `--registry <url>` | npm registry |
| `--node-mirror <url>` | Node download mirror |
| `--cn` | Shortcut for npmmirror (registry + Node) |
| `--libc <glibc\|musl>` | libc for Linux targets (default `glibc`) |
| `-o, --out <dir>` | Output directory (default `./out`) |
| `-z, --archive` | Package the result (`.tar.gz`, or `.zip` for Windows) |
| `--fresh` | Ignore the cached runtime tree and reinstall |

Targets: `linux-x64` `linux-arm64` `darwin-x64` `darwin-arm64` `win-x64` `win-arm64`

```bash
./build.sh -t all -z                           # every platform, packaged
./build.sh -t linux-x64,win-x64 -d 0.1.0-rc.8
./build.sh --cn                                # China mirrors
```

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
              → assemble → portability self-check → package
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
| extract `.zip` | bsdtar on Windows/macOS; `unzip` on Linux |
| create `.zip` | none — built-in `lib/zip.mjs` |
| directory sizes | none — computed in Node |

## Security note

`data/dsh-home/.credentials.yaml` holds **plaintext** API credentials. Losing the
USB stick means losing the credentials. Encrypt it before putting the folder on
removable media, or exclude it and re-authenticate on the new machine.

## Known limitations

- exFAT/FAT32 USB sticks don't support symlinks. The remaining links are all `.bin/`
  CLI shims; DSH invokes `node .../lib/bin.js` directly, so nothing breaks.
- Moving between Linux and Windows requires building both targets.
- Upstream adaptation risk is yours — no third party vets a new DSH release for you.
  Snapshot before upgrading.

## Test status

Measured on Arch Linux x86_64 with `-t linux-x64,win-x64`:

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
| Built-in ZIP writer | ✅ `unzip -t` clean, CRLF correct |

**Untested:** `build.ps1` has never run on Windows (no PowerShell on the dev machine);
macOS and Windows outputs were verified for layout and packaging but never launched
on real hardware; arm64 targets have not been built.

## Related

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — upstream DSH
- [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) — community portable build with a Tauri shell
- [hairyf/deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop) — Tauri desktop app
- [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable) — Windows portable build

## License

MIT. DeepSeek Harness and its name and logo belong to DeepSeek; this project is a
packaging wrapper around the official npm release and is not an official artifact.
