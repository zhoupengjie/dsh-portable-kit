#!/usr/bin/env node
// DSH Portable 构建系统 —— 主逻辑
//
// 设计要点(全部来自实测,见 README.md「为什么这么做」):
//   1. DSH 是纯 npm 包。用 npm 扁平安装(--ignore-scripts),node_modules 里
//      只剩 .bin/ 下的相对符号链接,复制/解压/插U盘都不会坏。
//   2. 453 个包里只有 6 个绑平台,且都用 optionalDependencies 的平台变体模式。
//      先装「胖树」(--force 拉全平台变体),再按目标平台裁剪。
//   3. dsh plugin 转发给 pnpm,而 DSH 不捆绑 pnpm —— 必须自己装进去。
//   4. pnpm 的 node-linker=hoisted 必须走环境变量,写 .npmrc 不可靠(实测)。

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync } from 'node:fs'
import { chmod, cp, mkdir, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// ── 目标平台表 ────────────────────────────────────────────────────────────
// npmOs/npmCpu 对应 package.json 的 os/cpu 字段取值
const TARGETS = {
  'linux-x64':    { npmOs: 'linux',  npmCpu: 'x64',   nodeArchive: (v) => `node-${v}-linux-x64.tar.gz`,    nodeDir: (v) => `node-${v}-linux-x64`,    exe: false },
  'linux-arm64':  { npmOs: 'linux',  npmCpu: 'arm64', nodeArchive: (v) => `node-${v}-linux-arm64.tar.gz`,  nodeDir: (v) => `node-${v}-linux-arm64`,  exe: false },
  'darwin-x64':   { npmOs: 'darwin', npmCpu: 'x64',   nodeArchive: (v) => `node-${v}-darwin-x64.tar.gz`,   nodeDir: (v) => `node-${v}-darwin-x64`,   exe: false },
  'darwin-arm64': { npmOs: 'darwin', npmCpu: 'arm64', nodeArchive: (v) => `node-${v}-darwin-arm64.tar.gz`, nodeDir: (v) => `node-${v}-darwin-arm64`, exe: false },
  'win-x64':      { npmOs: 'win32',  npmCpu: 'x64',   nodeArchive: (v) => `node-${v}-win-x64.zip`,         nodeDir: (v) => `node-${v}-win-x64`,      exe: true },
  'win-arm64':    { npmOs: 'win32',  npmCpu: 'arm64', nodeArchive: (v) => `node-${v}-win-arm64.zip`,       nodeDir: (v) => `node-${v}-win-arm64`,    exe: true },
}

// ── 参数 ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    host: null,
    targets: null,
    dshVersion: 'latest',
    pnpmVersion: '11.7.0',
    nodeVersion: process.env.DSH_BUILD_NODE_VERSION || 'v24.19.0',
    registry: process.env.DSH_BUILD_REGISTRY || 'https://registry.npmjs.org/',
    nodeMirror: process.env.DSH_BUILD_NODE_MIRROR || 'https://nodejs.org/dist',
    libc: 'glibc',
    out: path.join(ROOT, 'out'),
    fresh: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const [key, inline] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], undefined]
    const next = () => (inline !== undefined ? inline : argv[++i])
    switch (key) {
      case '--host': opts.host = next(); break
      case '--targets': case '-t': opts.targets = next(); break
      case '--dsh-version': case '-d': opts.dshVersion = next(); break
      case '--pnpm-version': opts.pnpmVersion = next(); break
      case '--node-version': opts.nodeVersion = next(); break
      case '--registry': opts.registry = next(); break
      case '--node-mirror': opts.nodeMirror = next(); break
      case '--libc': opts.libc = next(); break
      case '--out': case '-o': opts.out = path.resolve(next()); break
      case '--fresh': opts.fresh = true; break
      case '--cn': // 国内镜像快捷方式
        opts.registry = 'https://registry.npmmirror.com/'
        opts.nodeMirror = 'https://npmmirror.com/mirrors/node'
        break
      case '--help': case '-h': usage(); process.exit(0); break
      default: throw new Error(`Unknown option: ${key}`)
    }
  }
  if (!opts.targets) opts.targets = opts.host || 'linux-x64'
  const list = opts.targets === 'all' ? Object.keys(TARGETS) : opts.targets.split(',').map((s) => s.trim()).filter(Boolean)
  for (const t of list) if (!TARGETS[t]) throw new Error(`Unknown target: ${t} (choose from ${Object.keys(TARGETS).join(', ')}, all)`)
  opts.targetList = list

  // Windows 宿主只能构建 Windows 目标。NTFS 没有可执行位,fs.chmod 在 Windows 上
  // 只切换只读属性;而系统自带的 bsdtar 不支持 --mode/--uid/--gid,打出的 tar.gz
  // 里所有文件都是 0644 —— 解到 Linux 后连 runtime/node/bin/node 都 Permission
  // denied(实测)。这类产物构建时退出码为 0,坏在使用时,必须提前拦住。
  if (process.platform === 'win32') {
    const posix = list.filter((t) => TARGETS[t].npmOs !== 'win32')
    if (posix.length > 0) {
      throw new Error(`A Windows host cannot build ${posix.join(', ')}: the result loses executable bits, ` +
        `so not even node will run on the target machine.\n` +
        `    Build these targets on Linux / macOS (WSL is enough) - a POSIX host can build every platform, Windows included.`)
    }
  }

  return opts
}

function usage() {
  process.stdout.write(`
DSH Portable builder

  ./build.sh [options]            (Windows: powershell -ExecutionPolicy Bypass -File build.ps1 [options])

Options
  -t, --targets <list>     Comma-separated targets, or all (default: host platform)
                           One of: ${Object.keys(TARGETS).join(', ')}
  -d, --dsh-version <ver>  DSH version, e.g. 0.1.1-rc.1 / latest / next (default: latest)
      --pnpm-version <ver>   pnpm version (default: 11.7.0)
      --node-version <ver>   Node version (default: v24.19.0)
      --registry <url>       npm registry
      --node-mirror <url>    Node download mirror
      --cn                   Shortcut for the npmmirror registry and Node mirror
      --libc <glibc|musl>    libc for Linux targets (default: glibc)
  -o, --out <dir>          Output directory (default: ./out)
      --fresh              Ignore the cached runtime tree and reinstall
  -h, --help               Show this help

Examples
  ./build.sh                                     # host platform only
  ./build.sh -t all                              # every platform (POSIX host)
  ./build.sh -t linux-x64,win-x64 -d 0.1.1-rc.1  # pick platforms and version
  ./build.sh --cn -t linux-x64                   # use China mirrors

A POSIX host can build every target; a Windows host can only build win-* targets.
`)
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const log = (msg) => process.stdout.write(`==> ${msg}\n`)
const detail = (msg) => process.stdout.write(`    ${msg}\n`)

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (exit code ${result.status})`)
}

// npm 的位置随宿主平台变:POSIX 版 Node 是 bin/node + ../lib/node_modules/npm,
// Windows 版 zip 里是 node.exe + ./node_modules/npm —— 没有 lib/ 这一层。
function resolveNpmCli(nodeBin) {
  const dir = path.dirname(nodeBin)
  const candidates = [
    path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Linux / macOS
  ]
  const found = candidates.find((p) => existsSync(p))
  if (!found) throw new Error(`npm-cli.js not found in the host Node (looked in: ${candidates.join(', ')})`)
  return found
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed, HTTP ${response.status}: ${url}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  await mkdir(path.dirname(dest), { recursive: true })
  await writeFile(dest, bytes)
  return bytes
}

// ── 解包(宿主无关)────────────────────────────────────────────────────────
// .tar.gz:三个宿主平台的 tar 都能处理。
// .zip:Windows/macOS 的 tar 就是 bsdtar,原生支持;Linux 的 GNU tar 不支持,
//       退回 bsdtar 或 unzip —— 两者有其一即可,不必都装。
const ZIP_EXTRACTORS = [
  // bsdtar 排在前面:libarchive 是很多发行版的基础组件(Arch 的 base 就带它),
  // 而 unzip 往往要单独装。实测本项目开发机 Arch 上正是有 bsdtar 而无 unzip。
  { cmd: 'bsdtar', probe: ['--version'], args: (a, d) => ['-xf', a, '-C', d] },
  { cmd: 'unzip', probe: ['-v'], args: (a, d) => ['-q', a, '-d', d] },
]

// Windows 建符号链接要管理员权限或开发者模式,而 Linux/macOS 版 Node 的
// bin/npm、npx、corepack 都是符号链接 —— 普通用户跑 bsdtar 必然在这三个上失败。
// 它们都是指向包内 .js 的相对链接,而那些 .js 自带 #!/usr/bin/env node,
// 所以按内容复制成普通文件,行为与符号链接完全等价。
function materializeSymlinks(archive, destDir) {
  const listing = spawnSync('tar', ['-tvf', archive], { encoding: 'utf8' })
  if (listing.error || listing.status !== 0) return []
  const repaired = []
  for (const line of listing.stdout.split('\n')) {
    if (!line.startsWith('l')) continue
    const arrow = line.indexOf(' -> ')
    if (arrow < 0) continue
    // 左半段以路径结尾(Node 官方包路径不含空格);右半段是链接目标
    const link = line.slice(0, arrow).trim().split(/\s+/).pop()
    const target = line.slice(arrow + 4).trim()
    const linkPath = path.join(destDir, link)
    const targetPath = path.resolve(path.dirname(linkPath), target)
    if (existsSync(linkPath) || !existsSync(targetPath)) continue
    copyFileSync(targetPath, linkPath)
    repaired.push(link)
  }
  return repaired
}

function extract(archive, destDir) {
  if (archive.endsWith('.zip')) {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      run('tar', ['-xf', archive, '-C', destDir])
      return
    }
    for (const { cmd, probe, args } of ZIP_EXTRACTORS) {
      if (spawnSync(cmd, probe, { stdio: 'ignore' }).error) continue
      run(cmd, args(archive, destDir))
      return
    }
    throw new Error(`Extracting ${path.basename(archive)} needs bsdtar or unzip - install either one ` +
      `(Arch: pacman -S libarchive | unzip; Debian/Ubuntu: apt install libarchive-tools | unzip)`)
  }
  // 交叉构建 POSIX 目标时,宿主若是 Windows 会卡在符号链接上,失败后补救
  if (process.platform === 'win32') {
    const result = spawnSync('tar', ['-xzf', archive, '-C', destDir], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) {
      const repaired = materializeSymlinks(archive, destDir)
      if (repaired.length === 0) {
        throw new Error(`Failed to extract ${path.basename(archive)} (exit code ${result.status})`)
      }
      detail(`Windows cannot create symlinks; restored ${repaired.length} by copying: ${repaired.join(', ')}`)
    }
    return
  }
  run('tar', ['-xzf', archive, '-C', destDir])
}

// 递归统计目录占用(替代 du,Windows 上没有 du)
async function dirSize(dir) {
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += await dirSize(full)
    else if (entry.isFile()) total += (await stat(full)).size
  }
  return total
}

const humanSize = (bytes) => (bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(1)}G` : `${Math.round(bytes / (1 << 20))}M`)

// ── Node 运行时:按目标平台拉取 + 官方 SHASUMS 校验 ─────────────────────────
async function fetchNodeRuntime(target, opts) {
  const spec = TARGETS[target]
  const version = opts.nodeVersion
  const toolchain = path.join(ROOT, '.toolchain')
  const dir = path.join(toolchain, spec.nodeDir(version))
  const nodeBin = spec.exe ? path.join(dir, 'node.exe') : path.join(dir, 'bin', 'node')
  if (existsSync(nodeBin)) return dir

  const archive = spec.nodeArchive(version)
  const dest = path.join(toolchain, 'downloads', archive)
  log(`Fetching Node runtime ${version} (${target})`)
  if (!existsSync(dest)) await download(`${opts.nodeMirror}/${version}/${archive}`, dest)

  const sumsFile = path.join(toolchain, 'downloads', `SHASUMS256-${version}.txt`)
  if (!existsSync(sumsFile)) await download(`${opts.nodeMirror}/${version}/SHASUMS256.txt`, sumsFile)
  const sums = await readFile(sumsFile, 'utf8')
  const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === archive)?.[0]
  if (!want) throw new Error(`${archive} not listed in SHASUMS256.txt`)
  const got = createHash('sha256').update(await readFile(dest)).digest('hex')
  if (want !== got) { await rm(dest, { force: true }); throw new Error(`Node checksum mismatch for ${archive}: expected ${want}, got ${got}`) }
  detail(`Checksum OK ${want.slice(0, 12)}...`)

  extract(dest, toolchain)
  if (!existsSync(nodeBin)) throw new Error(`node missing after extraction: ${nodeBin}`)
  return dir
}

// ── 扫描 node_modules,建立平台包索引 ──────────────────────────────────────
// 返回 { platformPkgs: [{name, dir, os, cpu, libc}], families: Set<变体包名> }
async function scanTree(nodeModules) {
  const platformPkgs = []
  const optionalOwners = new Map() // 变体包名 -> 拥有它的父包
  const families = new Set()

  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.name.startsWith('@')) { await walk(full); continue }
      const manifest = await readJson(path.join(full, 'package.json'))
      if (manifest) {
        if (manifest.os || manifest.cpu || manifest.libc) {
          platformPkgs.push({ name: manifest.name, dir: full, os: manifest.os, cpu: manifest.cpu, libc: manifest.libc })
        }
        for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
          if (!optionalOwners.has(dep)) optionalOwners.set(dep, manifest.optionalDependencies)
        }
      }
      const nested = path.join(full, 'node_modules')
      if (existsSync(nested)) await walk(nested)
    }
  }
  await walk(nodeModules)

  // 一个包若是平台变体,把它所在家族的全部兄弟都收进来
  for (const pkg of platformPkgs) {
    const siblings = optionalOwners.get(pkg.name)
    if (siblings) for (const name of Object.keys(siblings)) families.add(name)
  }
  return { platformPkgs, families, optionalOwners }
}

// ── 构建「胖树」:装全部平台变体,后续按目标裁剪 ───────────────────────────
// dist-tag(next / latest)必须先解析成具体版本号再做缓存键,
// 否则上游发新版后 `-d next` 会命中旧缓存,静默构建出过时产物。
async function resolveDshVersion(opts) {
  if (/^\d+\.\d+\.\d+/.test(opts.dshVersion)) return opts.dshVersion
  const base = opts.registry.replace(/\/+$/, '')
  const meta = await (await fetch(`${base}/@deepseek-ai%2Fdsh`)).json()
  const tags = meta?.['dist-tags'] ?? {}
  const resolved = tags[opts.dshVersion]
  if (!resolved) {
    throw new Error(`No dist-tag "${opts.dshVersion}" on the registry (available: ${Object.keys(tags).join(', ')})`)
  }
  detail(`dist-tag ${opts.dshVersion} -> ${resolved}`)
  return resolved
}

async function buildFatBase(opts) {
  const version = await resolveDshVersion(opts)
  opts.dshVersion = version // 钉死到具体版本,后续 package.json 与缓存键都用它
  const base = path.join(ROOT, '.cache', `base-${version}-node${opts.nodeVersion}`)
  const marker = path.join(base, '.fat-complete')
  if (existsSync(marker) && !opts.fresh) {
    log(`Reusing cached runtime tree: ${path.relative(ROOT, base)}`)
    return base
  }
  if (opts.fresh) log('--fresh: ignoring cache, reinstalling the runtime tree')

  await rm(base, { recursive: true, force: true })
  await mkdir(base, { recursive: true })
  const hostNode = process.execPath
  const npmCli = resolveNpmCli(hostNode)
  const npm = (args) => run(hostNode, [npmCli, ...args], {
    cwd: base,
    env: {
      ...process.env,
      npm_config_registry: opts.registry,
      npm_config_audit: 'false',
      npm_config_fund: 'false',
      // 缓存留在项目内:不污染 ~/.npm,同时让跨版本构建仍能复用已下载的包
      npm_config_cache: path.join(ROOT, '.cache', 'npm'),
    },
  })

  // 第一遍:官方包 + pnpm(DSH 不捆绑 pnpm,但 dsh plugin 要转发给它)
  log(`Installing @deepseek-ai/dsh@${opts.dshVersion} and pnpm@${opts.pnpmVersion} (flat, link-free layout)`)
  await writeFile(path.join(base, 'package.json'), `${JSON.stringify({
    name: 'dsh-portable-runtime', private: true,
    dependencies: { '@deepseek-ai/dsh': opts.dshVersion, pnpm: opts.pnpmVersion },
  }, null, 2)}\n`)
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'])

  // 第二遍:把平台变体家族的全部兄弟也拉进来(--force 绕过 os/cpu 校验)
  const { families } = await scanTree(path.join(base, 'node_modules'))
  if (families.size > 0) {
    log(`Adding all-platform native variants (${families.size} packages)`)
    const manifest = await readJson(path.join(base, 'package.json'))
    for (const name of families) manifest.dependencies[name] = '*'
    await writeFile(path.join(base, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    npm(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--force'])
  }

  await writeFile(marker, new Date().toISOString())
  return base
}

// ── 按目标平台裁剪 ────────────────────────────────────────────────────────
function compatible(pkg, target, libc) {
  const spec = TARGETS[target]
  const ok = (field, value) => !field || field.length === 0 || field.includes(value) ||
    field.some((v) => v.startsWith('!') && v.slice(1) !== value)
  return ok(pkg.os, spec.npmOs) && ok(pkg.cpu, spec.npmCpu) &&
    (spec.npmOs !== 'linux' ? true : ok(pkg.libc, libc))
}

async function pruneForTarget(appDir, target, libc) {
  const { platformPkgs } = await scanTree(path.join(appDir, 'node_modules'))
  let removed = 0
  let kept = 0
  for (const pkg of platformPkgs) {
    if (compatible(pkg, target, libc)) { kept += 1; continue }
    await rm(pkg.dir, { recursive: true, force: true })
    removed += 1
  }
  detail(`Native packages: kept ${kept}, pruned ${removed}`)
}

// ── 启动脚本 ──────────────────────────────────────────────────────────────
// 关键环境变量全部在这里设置,详见 README「可移动性配方」
const SH_ENV = `ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export DSH_HOME="\${DSH_HOME:-$ROOT/data/dsh-home}"
export DSH_PORTABLE=1
export DSH_PORTABLE_ROOT="$ROOT"
export DSH_TELEMETRY_MODE=DISABLED
export pnpm_config_store_dir="$ROOT/data/pnpm-store"
export pnpm_config_node_linker=hoisted
export PATH="$ROOT/runtime/node/bin:$ROOT:$PATH"
NODE="$ROOT/runtime/node/bin/node"
ENTRY="$ROOT/app/node_modules/@deepseek-ai/dsh/lib/bin.js"
mkdir -p "$DSH_HOME" "$ROOT/data/pnpm-store"`

const CMD_ENV = `set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"
if not defined DSH_HOME set "DSH_HOME=%ROOT%\\data\\dsh-home"
set "DSH_PORTABLE=1"
set "DSH_PORTABLE_ROOT=%ROOT%"
set "DSH_TELEMETRY_MODE=DISABLED"
set "pnpm_config_store_dir=%ROOT%\\data\\pnpm-store"
set "pnpm_config_node_linker=hoisted"
set "PATH=%ROOT%\\runtime\\node;%ROOT%;%PATH%"
set "NODE=%ROOT%\\runtime\\node\\node.exe"
set "ENTRY=%ROOT%\\app\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js"
if not exist "%DSH_HOME%" mkdir "%DSH_HOME%"
if not exist "%ROOT%\\data\\pnpm-store" mkdir "%ROOT%\\data\\pnpm-store"`

// 快照逻辑只写这一份,随产物发到 launcher/snapshot.mjs。
// sh 与 cmd 的 dsh-snap / dsh-restore 都只是三行包装 —— 和 build.sh / build.ps1
// 对 build.mjs 的关系一致,避免在 batch 里重写一遍保留策略。
const SNAPSHOT_MJS = `#!/usr/bin/env node
// DSH 便携版分层快照
//
// 只归档无法重建的东西:会话、设置、凭据、插件清单、workspace。
// profiles/*/node_modules 不入档 —— 可从包内 pnpm store 离线重建。
//
// 用法(经 dsh-snap / dsh-restore 调用):
//   snapshot.mjs create [名字]   snapshot.mjs prune
//   snapshot.mjs list            snapshot.mjs restore <名字>

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SNAPS = path.join(ROOT, 'snapshots')
const DATA = path.join(ROOT, 'data')
const DSH_HOME = process.env.DSH_HOME || path.join(DATA, 'dsh-home')
const KEEP = Number.parseInt(process.env.DSH_SNAPSHOT_KEEP || '10', 10)
const AUTO_PREFIX = 'auto-'

function run(cmd, args, options) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, options || {}))
  if (r.error) throw r.error
  if (r.status !== 0) throw new Error(cmd + ' 失败(退出码 ' + r.status + ')')
}

async function dirSize(dir) {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) total += await dirSize(full)
    else if (e.isFile()) total += (await stat(full)).size
  }
  return total
}

const human = (b) => (b >= 1048576 ? Math.round(b / 1048576) + 'MB' : Math.max(1, Math.round(b / 1024)) + 'KB')

function stamp() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
}

async function listSnapshots() {
  if (!existsSync(SNAPS)) return []
  const entries = await readdir(SNAPS, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}

// 保留策略:只清理 auto-* 自动快照,保留最近 KEEP 份。手动命名的永不自动删除。
async function prune(quiet) {
  const autos = (await listSnapshots()).filter((n) => n.startsWith(AUTO_PREFIX))
  if (autos.length <= KEEP) return
  for (const name of autos.slice(0, autos.length - KEEP)) {
    await rm(path.join(SNAPS, name), { recursive: true, force: true })
    if (!quiet) console.log('Pruned old auto snapshot: ' + name)
  }
}

async function create(name) {
  const target = name || stamp()
  const dest = path.join(SNAPS, target)
  await mkdir(dest, { recursive: true })
  if (existsSync(DSH_HOME)) {
    run('tar', ['-czf', path.join(dest, 'dsh-home.tar.gz'), '-C', path.dirname(DSH_HOME),
      '--exclude', path.basename(DSH_HOME) + '/profiles/*/node_modules',
      '--exclude', path.basename(DSH_HOME) + '/logs',
      path.basename(DSH_HOME)])
  }
  if (existsSync(path.join(ROOT, 'workspace'))) {
    run('tar', ['-czf', path.join(dest, 'workspace.tar.gz'), '-C', ROOT, 'workspace'])
  }
  if (existsSync(path.join(ROOT, 'VERSION.json'))) {
    run('tar', ['-czf', path.join(dest, 'version.tar.gz'), '-C', ROOT, 'VERSION.json'])
  }
  console.log('Snapshot saved: snapshots/' + target + '  (' + human(await dirSize(dest)) + ')')
  await prune(false)
}

async function show() {
  const names = await listSnapshots()
  if (names.length === 0) { console.log('No snapshots yet.'); return }
  console.log('NAME'.padEnd(30) + 'SIZE'.padStart(8))
  for (const name of names) {
    console.log(name.padEnd(30) + human(await dirSize(path.join(SNAPS, name))).padStart(8))
  }
  console.log('\\nKeeping the newest ' + KEEP + ' auto snapshots (DSH_SNAPSHOT_KEEP to change); named ones are never pruned.')
}

async function restore(name) {
  if (!name) {
    console.error('Usage: dsh-restore <name>\\nAvailable snapshots:')
    for (const n of await listSnapshots()) console.error('  ' + n)
    process.exit(2)
  }
  const src = path.join(SNAPS, name)
  if (!existsSync(src)) { console.error('Snapshot not found: ' + name); process.exit(1) }
  console.log('Restoring ' + name + ' ...')
  if (existsSync(path.join(src, 'dsh-home.tar.gz'))) {
    await rm(DSH_HOME, { recursive: true, force: true })
    run('tar', ['-xzf', path.join(src, 'dsh-home.tar.gz'), '-C', path.dirname(DSH_HOME)])
  }
  if (existsSync(path.join(src, 'workspace.tar.gz'))) {
    await rm(path.join(ROOT, 'workspace'), { recursive: true, force: true })
    run('tar', ['-xzf', path.join(src, 'workspace.tar.gz'), '-C', ROOT])
  }
  // 从包内 pnpm store 离线重建每个 profile 的依赖
  const profilesRoot = path.join(DSH_HOME, 'profiles')
  const node = process.execPath
  const entry = path.join(ROOT, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(profilesRoot)) {
    for (const e of await readdir(profilesRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !existsSync(path.join(profilesRoot, e.name, 'package.json'))) continue
      console.log('Rebuilding plugin deps: ' + e.name)
      spawnSync(node, [entry, 'plugin', '--profile', e.name, 'install', '--force'], { stdio: 'inherit' })
    }
  }
  console.log('Restore complete.')
}

const [action, arg] = process.argv.slice(2)
const actions = {
  create,
  auto: () => create(AUTO_PREFIX + stamp()), // 自动快照带 auto- 前缀,才会被保留策略回收
  prune: () => prune(false),
  list: show,
  restore,
}
if (!actions[action]) { console.error('Unknown action: ' + action); process.exit(2) }
await actions[action](arg)
`

const LAUNCHERS_SH = {
  // dsh:CLI 直通,插件管理等都走它
  dsh: `#!/bin/sh
# DSH Portable CLI - forwards every argument to the official dsh.
# Commands that mutate plugin config (add/remove/update/install) trigger a snapshot first.
set -eu
${SH_ENV}

# Detect a plugin subcommand that mutates config
is_mutating() {
  seen_plugin=0
  for arg in "$@"; do
    if [ "$seen_plugin" = 1 ]; then
      case "$arg" in
        add|install|remove|rm|uninstall|update|up) return 0 ;;
      esac
    fi
    [ "$arg" = plugin ] && seen_plugin=1
  done
  return 1
}

if [ "\${DSH_AUTO_SNAPSHOT:-1}" != 0 ] && is_mutating "$@"; then
  if "$NODE" "$ROOT/launcher/snapshot.mjs" auto >/dev/null 2>&1; then
    echo "Snapshot taken (set DSH_AUTO_SNAPSHOT=0 to disable)" >&2
  else
    echo "Auto-snapshot failed, continuing anyway" >&2
  fi
fi

exec "$NODE" "$ENTRY" "$@"
`,
  // pnpm shim:dsh plugin 会在 PATH 里找 pnpm
  pnpm: `#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT/runtime/node/bin/node" "$ROOT/app/node_modules/pnpm/bin/pnpm.cjs" "$@"
`,
  // start:拉起 web 服务,轮询就绪后用浏览器 app 模式打开
  start: `#!/bin/sh
# Start DSH Portable: run the web server, open a browser window once ready
set -eu
${SH_ENV}
PORT=\${DSH_PORT:-3080}
[ -f "$ROOT/port.txt" ] && PORT=$(tr -dc 0-9 < "$ROOT/port.txt")
URL="http://127.0.0.1:$PORT"

port_open() { "$NODE" -e '
const net=require("net");const s=net.connect(+process.argv[1],"127.0.0.1");
s.on("connect",()=>{s.destroy();process.exit(0)});
s.on("error",()=>process.exit(1));setTimeout(()=>process.exit(1),800);' "$PORT" 2>/dev/null; }

open_window() {
  for browser in "\${BROWSER:-}" chromium chromium-browser google-chrome google-chrome-stable microsoft-edge brave-browser; do
    [ -n "$browser" ] || continue
    if command -v "$browser" >/dev/null 2>&1; then
      "$browser" --app="$URL" --user-data-dir="$ROOT/data/browser" --no-first-run --disable-default-apps >/dev/null 2>&1 &
      return 0
    fi
  done
  command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 && return 0
  command -v open >/dev/null 2>&1 && open "$URL" >/dev/null 2>&1 && return 0
  echo "No browser found; open $URL manually"
}

if port_open; then echo "DSH is already running. Opening $URL"; open_window; exit 0; fi

echo "Starting DSH... (data directory: $DSH_HOME)"
"$NODE" "$ENTRY" web --port "$PORT" --no-open &
DSH_PID=$!
trap 'kill $DSH_PID 2>/dev/null || true' INT TERM

i=0
while [ $i -lt 90 ]; do
  if port_open; then echo "Ready: $URL"; open_window; break; fi
  kill -0 $DSH_PID 2>/dev/null || { echo "DSH exited early; run ./dsh web --port $PORT directly to see the error" >&2; exit 1; }
  sleep 1; i=$((i + 1))
done
wait $DSH_PID
`,
  // snap / restore:分层快照,只存资产与插件清单,不存 node_modules
  // 快照:薄包装,逻辑在 launcher/snapshot.mjs
  'dsh-snap': `#!/bin/sh
# Layered snapshot. Usage: ./dsh-snap [name] | --list | --prune
set -eu
${SH_ENV}
case "\${1:-}" in
  --list|-l) exec "$NODE" "$ROOT/launcher/snapshot.mjs" list ;;
  --prune)   exec "$NODE" "$ROOT/launcher/snapshot.mjs" prune ;;
esac
exec "$NODE" "$ROOT/launcher/snapshot.mjs" create "\${1:-}"
`,
  'dsh-restore': `#!/bin/sh
# Restore from a snapshot. Usage: ./dsh-restore <name> (no argument lists available ones)
set -eu
${SH_ENV}
exec "$NODE" "$ROOT/launcher/snapshot.mjs" restore "\${1:-}"
`,
}

// .cmd 一律只用 ASCII:批处理由 cmd.exe 按控制台代码页(中文机器是 GBK)解码,
// 而我们写出去的是 UTF-8 —— 里面的中文会变成乱码,严重时还可能撞上 cmd 的
// 特殊字符导致解析出错。所以 Windows 启动器的提示文案统一用英文。
// Windows 版 start.cmd 用的「等就绪→开浏览器」小工具。
//
// 为什么单独一个文件:start.cmd 必须让 web 服务留在前台(前台才能被 Ctrl-C
// 和关窗口回收),所以开浏览器这件事得后台做。早先是 start /b 自调用
// start.cmd,但 start 启动 .cmd 时用的是 cmd /K —— 执行完保留,会在同一个
// 控制台里多出一个提示符,看起来像「没阻塞」(实测踩过)。改成后台跑这个
// 脚本就没有 cmd 参与,也就没有 /K 的问题。
const OPEN_BROWSER_MJS = `#!/usr/bin/env node
// 轮询端口,就绪后用系统默认浏览器打开。由 start.cmd 后台调用。
import { connect } from 'node:net'
import { spawn } from 'node:child_process'

const port = Number(process.argv[2] || 3080)
const url = 'http://127.0.0.1:' + port
const MAX_TRIES = 90
let tries = 0

function attempt() {
  const socket = connect(port, '127.0.0.1')
  let settled = false
  const finish = (ready) => {
    if (settled) return
    settled = true
    socket.destroy()
    if (ready) {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
      return
    }
    if (++tries >= MAX_TRIES) process.exit(1)
    setTimeout(attempt, 1000)
  }
  socket.on('connect', () => finish(true))
  socket.on('error', () => finish(false))
  setTimeout(() => finish(false), 800)
}

attempt()
`

const LAUNCHERS_CMD = {
  'dsh.cmd': `@echo off
setlocal
${CMD_ENV}
rem Snapshot automatically before any command that mutates plugin config
rem (set DSH_AUTO_SNAPSHOT=0 to disable).
if "%DSH_AUTO_SNAPSHOT%"=="0" goto :forward
if /I not "%~1"=="plugin" goto :forward
for %%A in (%*) do (
  if /I "%%~A"=="add"       goto :snap
  if /I "%%~A"=="install"   goto :snap
  if /I "%%~A"=="remove"    goto :snap
  if /I "%%~A"=="rm"        goto :snap
  if /I "%%~A"=="uninstall" goto :snap
  if /I "%%~A"=="update"    goto :snap
  if /I "%%~A"=="up"        goto :snap
)
goto :forward
:snap
"%NODE%" "%ROOT%\launcher\snapshot.mjs" auto >nul 2>&1 && echo Snapshot taken ^(set DSH_AUTO_SNAPSHOT=0 to disable^) 1>&2
:forward
"%NODE%" "%ENTRY%" %*
`,
  'dsh-snap.cmd': `@echo off
setlocal
${CMD_ENV}
if /I "%~1"=="--list"  ("%NODE%" "%ROOT%\launcher\snapshot.mjs" list  & exit /b %ERRORLEVEL%)
if /I "%~1"=="--prune" ("%NODE%" "%ROOT%\launcher\snapshot.mjs" prune & exit /b %ERRORLEVEL%)
"%NODE%" "%ROOT%\launcher\snapshot.mjs" create %1
`,
  'dsh-restore.cmd': `@echo off
setlocal
${CMD_ENV}
"%NODE%" "%ROOT%\launcher\snapshot.mjs" restore %1
`,
  'pnpm.cmd': `@echo off
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\\" set "ROOT=%ROOT:~0,-1%"
"%ROOT%\runtime\node\node.exe" "%ROOT%\app\node_modules\pnpm\bin\pnpm.cjs" %*
`,
  // 与 POSIX 版 start 对齐:服务跑在前台并阻塞(前台才能被 Ctrl-C 和关窗口
  // 回收 —— 早先用 start /b 分离启动,关掉控制台后服务变孤儿、端口一直被占)。
  // 启动前先探测端口,已在运行就只开窗口;开浏览器交给后台的 open-browser.mjs。
  // 端口探测复用包内 Node,不依赖 netstat(输出随系统语言变化,不可靠)。
  'start.cmd': `@echo off
setlocal
${CMD_ENV}
set "PORT=3080"
if exist "%ROOT%\port.txt" set /p PORT=<"%ROOT%\port.txt"
set "URL=http://127.0.0.1:%PORT%"

call :probe
if not errorlevel 1 (
  echo DSH is already running. Opening %URL%
  start "" "%URL%"
  exit /b 0
)

echo Starting DSH... the browser will open at %URL% when ready.
echo Data directory: %DSH_HOME%
echo Press Ctrl+C to stop.
start "" /b "%NODE%" "%ROOT%\launcher\open-browser.mjs" %PORT%
"%NODE%" "%ENTRY%" web --port %PORT% --no-open
exit /b %ERRORLEVEL%

:probe
"%NODE%" -e "const net=require('net');const s=net.connect(+process.argv[1],'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),800)" %PORT% >nul 2>&1
exit /b %ERRORLEVEL%
`,
}

// ── 可移动性自检 ──────────────────────────────────────────────────────────
// 任何绝对路径符号链接都意味着产物绑死在构建机上,复制走就废了。
// 这是本工具最容易无声破功的地方(fs.cp 默认就会制造这种链接),必须硬校验。
async function verifyPortable(stage) {
  const offenders = []
  let total = 0
  async function walk(dir) {
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) {
        total += 1
        const target = await readlink(full)
        if (path.isAbsolute(target)) offenders.push(`${path.relative(stage, full)} -> ${target}`)
      } else if (entry.isDirectory()) {
        await walk(full)
      }
    }
  }
  await walk(stage)
  if (offenders.length > 0) {
    throw new Error(`Output contains ${offenders.length} absolute symlinks, which break when copied:\n  ${offenders.slice(0, 5).join('\n  ')}`)
  }
  detail(`Portability self-check passed (${total} symlinks, all relative)`)
}

// ── 组装一个目标平台的便携目录 ────────────────────────────────────────────
async function assemble(target, base, opts, dshVersionActual) {
  const spec = TARGETS[target]
  const stage = path.join(opts.out, `DSH-Portable-${target}`)
  log(`Assembling ${target}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })

  // 1) Node 运行时
  const runtimeSrc = await fetchNodeRuntime(target, opts)
  // verbatimSymlinks 必须为 true:否则 fs.cp 会把相对符号链接解析成绝对路径,
  // 产物里就会指回构建机的 .toolchain/ —— 直接毁掉可移动性(实测踩过)。
  await cp(runtimeSrc, path.join(stage, 'runtime', 'node'), { recursive: true, verbatimSymlinks: true })

  // 2) 应用树(从胖树复制后裁剪)
  await cp(path.join(base, 'node_modules'), path.join(stage, 'app', 'node_modules'), { recursive: true, verbatimSymlinks: true })
  await cp(path.join(base, 'package.json'), path.join(stage, 'app', 'package.json'))
  await pruneForTarget(path.join(stage, 'app'), target, opts.libc)

  // 3) 启动脚本 + 共用的快照逻辑
  await mkdir(path.join(stage, 'launcher'), { recursive: true })
  await writeFile(path.join(stage, 'launcher', 'snapshot.mjs'), SNAPSHOT_MJS)
  if (spec.npmOs === 'win32') {
    // open-browser.mjs 只有 .cmd 版需要;POSIX 版 start 自带浏览器探测逻辑
    await writeFile(path.join(stage, 'launcher', 'open-browser.mjs'), OPEN_BROWSER_MJS)
    for (const [name, body] of Object.entries(LAUNCHERS_CMD)) {
      await writeFile(path.join(stage, name), body.replace(/\n/g, '\r\n'))
    }
  } else {
    for (const [name, body] of Object.entries(LAUNCHERS_SH)) {
      const file = path.join(stage, name)
      await writeFile(file, body)
      await chmod(file, 0o755)
    }
  }

  // 4) 数据骨架 —— 保持空目录,整个目录随时可复制
  for (const dir of ['data/dsh-home', 'data/pnpm-store', 'workspace', 'snapshots']) {
    await mkdir(path.join(stage, dir), { recursive: true })
  }
  await writeFile(path.join(stage, 'data', 'README.txt'),
    'Sessions, settings, credentials and plugins live here. Copy this folder along\n' +
    'with the rest of DSH-Portable when moving the install.\n' +
    'WARNING: dsh-home/.credentials.yaml holds plaintext API credentials. Encrypt it\n' +
    'before putting this folder on removable media.\n\n' +
    '本目录保存会话、设置、凭据与插件。迁移时随整个 DSH-Portable 目录一起复制。\n' +
    '注意:dsh-home/.credentials.yaml 是明文 API 凭据,放到 U 盘前请自行加密。\n')
  await writeFile(path.join(stage, 'workspace', 'README.txt'),
    'Default workspace. Put your own plugin sources here.\n\n' +
    '默认工作区。自写插件源码放这里。\n')

  // 5) 版本清单
  const manifest = {
    schemaVersion: 1,
    builtFor: target,
    dshVersion: dshVersionActual,
    pnpmVersion: opts.pnpmVersion,
    nodeVersion: opts.nodeVersion,
    libc: spec.npmOs === 'linux' ? opts.libc : null,
    registry: opts.registry,
  }
  await writeFile(path.join(stage, 'VERSION.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const cli = spec.npmOs === 'win32' ? 'dsh.cmd' : './dsh'
  const launch = spec.npmOs === 'win32' ? '双击 start.cmd' : './start'
  const snap = spec.npmOs === 'win32'
    ? 'dsh-snap.cmd [名字]  /  dsh-restore.cmd <名字>'
    : './dsh-snap [名字]  /  ./dsh-restore <名字>'
  const footer = `DSH ${dshVersionActual} · Node ${opts.nodeVersion} · pnpm ${opts.pnpmVersion}`

  await writeFile(path.join(stage, 'README.md'), `# DSH Portable (${target})

[中文说明](./README_CN.md)

## Start

    ${spec.npmOs === 'win32' ? 'Double-click start.cmd' : './start'}

## Command line

    ${cli} plugin --profile web add <plugin>
    ${cli} plugin --profile web list --depth 0

## Snapshots (take one before installing plugins)

    ${spec.npmOs === 'win32'
      ? 'dsh-snap.cmd [name]  /  dsh-restore.cmd <name>'
      : './dsh-snap [name]  /  ./dsh-restore <name>'}

## Notes

- Custom port: create \`port.txt\` in this folder with the port number (default 3080).
- The whole folder can be copied, moved or put on a USB stick. All state lives in
  \`data/\`; nothing is written to your system user directory.${spec.npmOs === 'win32' ? '' : `
- When moving this folder, archive it first (\`tar -czf dsh.tar.gz <folder>\`).
  A plain copy can drop the executable bits and symlinks it needs.`}

${footer}
`)

  await writeFile(path.join(stage, 'README_CN.md'), `# DSH 便携版 (${target})

[English](./README.md)

## 启动

    ${launch}

## 命令行

    ${cli} plugin --profile web add <插件>
    ${cli} plugin --profile web list --depth 0

## 快照(装插件前建议先打一份)

    ${snap}

## 说明

- 自定义端口:在本目录建 \`port.txt\` 写入端口号(默认 3080)。
- 整个目录可复制、移动、放 U 盘;数据全在 \`data/\` 内,不写系统用户目录。${spec.npmOs === 'win32' ? '' : `
- 搬运本目录时请先打包(\`tar -czf dsh.tar.gz <目录>\`)。
  直接复制可能丢掉它需要的可执行位和符号链接。`}

${footer}
`)

  // 6) 可移动性自检 —— 产物里不允许出现绝对路径符号链接
  await verifyPortable(stage)

  return stage
}

// ── 主流程 ────────────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs(process.argv.slice(2))
  log(`Host ${opts.host} - targets ${opts.targetList.join(', ')}`)

  const base = await buildFatBase(opts)
  const installed = await readJson(path.join(base, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
  const dshVersionActual = installed?.version ?? opts.dshVersion
  detail(`Resolved DSH version: ${dshVersionActual}`)

  const built = []
  for (const target of opts.targetList) {
    built.push(await assemble(target, base, opts, dshVersionActual))
  }

  process.stdout.write('\nBuild complete:\n')
  for (const dir of built) {
    process.stdout.write(`  ${humanSize(await dirSize(dir)).padEnd(8)} ${path.relative(process.cwd(), dir)}\n`)
  }
}

main().catch((error) => {
  process.stderr.write(`\nBuild failed: ${error?.message || error}\n`)
  process.exitCode = 1
})
