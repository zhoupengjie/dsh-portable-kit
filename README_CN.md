# dsh-portable-build

**构建真正可移动的 DeepSeek Harness —— 一个文件夹,能拷进 U 盘,能 30 毫秒打快照,插件把它搞崩了能立刻回滚。**

[English](./README.md)

```bash
./build.sh && cd out/DSH-Portable-linux-x64 && ./start
```

不需要 Node、不需要 Rust、不需要 sudo,系统里什么都不装。

---

## 解决什么痛点

DSH 很强,但重度依赖插件,而插件质量参差不齐。实践中会踩三个坑,这里每个都有对应的解法。

### 1. 一个烂插件毁掉整套配置,而备份慢到没人愿意做

备份 2.2 GB 的安装目录要几分钟,所以没人会"以防万一"随手做 —— 而恰恰那时候最需要它。

**解法:分层快照。** 只归档无法重建的东西 —— 会话、设置、凭据、插件清单、workspace。
`node_modules` 不入档,因为它能从包内 pnpm store 离线重建。

```
./dsh-snap before-risky-plugin    # 实测 28KB,0.03 秒
./dsh-restore before-risky-plugin # 实测 562ms,依赖离线重建
```

快照还是**自动**的:任何 `dsh plugin add/remove/update` 执行前都会先打一份。
自动快照保留最近 10 份,手动命名的永不清理。

### 2. 号称"便携"的构建,一挪位置就废

pnpm 默认布局会造出数万个符号链接,并把绝对路径写进 `.modules.yaml`。
文件夹一复制就死。

**解法:一套实测出来、并且被强制校验的可移动性配方。**

| 问题 | 解法 | 实测结果 |
|---|---|---|
| pnpm 符号链接农场 | 运行时改用扁平 npm 安装 | 453 个包 → 12 个链接,全部相对 |
| 插件仍走 pnpm | `pnpm_config_node_linker=hoisted` 走**环境变量**而非 `.npmrc` | profile 链接 87 → 1 |
| pnpm store 跑到包外 | `pnpm_config_store_dir` 指向包内 | store 跟着产物走 |
| `fs.cp` 会把相对链接改成绝对 | `verbatimSymlinks: true` | 测试中真踩到 —— 19 个坏链接 |

只要产物里还剩任何绝对路径符号链接,构建就**直接失败**(`verifyPortable()`),
所以这条不会无声回归。

真机验证过:把产物复制到别的路径,`./dsh --version` 正常,`DSH_HOME` 跟着走,
装插件 895ms,布局仍是 hoisted。

### 3. 想用哪个版本,得等别人先发

`@deepseek-ai/dsh` 就是个普通 npm 包,但社区便携版都把它钉死,你只能等维护者。

| 路径 | 中间人 | 实测滞后 |
|---|---|---|
| WSL043/DSH-Portable | 手工 bump lock + 三平台成品测试 | 天级 |
| hairyf 桌面版 | 自动重打包仓库 | 6–13 小时 |
| **本构建器** | **无 —— 直连 npm** | **零** |

```bash
npm view @deepseek-ai/dsh dist-tags
./build.sh -d next          # 官方一发布就能构建
./build.sh -d 0.1.0-rc.7    # 随时回退,npm 上历史版本永久可用
```

dist-tag 会先解析成具体版本号再做缓存键,所以上游发新版后 `-d next` 是真的重新构建,
不会悄悄复用旧树。

---

## 快速开始

```bash
# Linux / macOS
./build.sh

# Windows
powershell -ExecutionPolicy Bypass -File .\build.ps1
```

然后:

```bash
cd out/DSH-Portable-linux-x64
./start          # 起服务,并打开一个独立浏览器窗口
```

### 环境要求

| 宿主 | 需要 |
|---|---|
| Linux | `curl`、`tar`(构建 Windows 目标时还需 `unzip`) |
| macOS | `curl`、`tar` —— 系统自带 |
| Windows | PowerShell 5.1+ —— Win10/11 自带 |

Node.js 由构建器自动下载并做 SHA256 校验。不往系统里装任何东西,工具链全在 `.toolchain/`。

## 用法

| 选项 | 说明 |
|---|---|
| `-t, --targets <列表>` | 目标平台,逗号分隔,或 `all`。默认宿主平台 |
| `-d, --dsh-version <版本>` | `latest` / `next` / `0.1.0-rc.8`。默认 `latest` |
| `--pnpm-version <版本>` | pnpm 版本(默认 `11.7.0`) |
| `--node-version <版本>` | Node 版本(默认 `v24.19.0`) |
| `--registry <地址>` | npm registry |
| `--node-mirror <地址>` | Node 下载源 |
| `--cn` | 一键切到 npmmirror(registry + Node 源) |
| `--libc <glibc\|musl>` | Linux 目标的 libc(默认 `glibc`) |
| `-o, --out <目录>` | 输出目录(默认 `./out`) |
| `-z, --archive` | 构建后打包(`.tar.gz`,Windows 出 `.zip`) |
| `--fresh` | 忽略缓存的运行时树,强制重新安装 |

可选目标:`linux-x64` `linux-arm64` `darwin-x64` `darwin-arm64` `win-x64` `win-arm64`

```bash
./build.sh -t all -z                           # 全平台 + 打包
./build.sh -t linux-x64,win-x64 -d 0.1.0-rc.8
./build.sh --cn                                # 国内镜像
```

## 产物结构

```
DSH-Portable-<平台>/
├── start / start.cmd        启动服务 + 独立浏览器窗口
├── dsh / dsh.cmd            CLI 直通(改插件时自动快照)
├── pnpm / pnpm.cmd          pnpm shim
├── dsh-snap / dsh-snap.cmd  快照
├── dsh-restore(.cmd)        回滚
├── launcher/snapshot.mjs    快照逻辑(两平台共用同一份)
├── runtime/node/            固定版 Node
├── app/node_modules/        DSH 内核 + pnpm + 该平台原生变体
├── data/
│   ├── dsh-home/            $DSH_HOME:会话 / 设置 / 凭据 / 插件
│   ├── pnpm-store/          插件离线重建的本钱
│   └── browser/             浏览器窗口的独立 profile
├── workspace/               默认工作区
├── snapshots/
└── VERSION.json
```

可以复制、移动、放进 U 盘。所有路径都在启动时由脚本从自身位置算出。

## 插件

插件装进 profile 目录,随整个便携目录走:

```
data/dsh-home/profiles/web/
├── package.json          装了什么
├── pnpm-lock.yaml        锁定版本
├── pnpm-workspace.yaml   pnpm 自动生成,记录 nodeLinker: hoisted
└── node_modules/         插件本体
```

```bash
./dsh plugin --profile web add <插件>
./dsh plugin --profile web list --depth 0
./dsh plugin --profile web update <包名>
./dsh plugin --profile web remove <包名>
```

本地插件要用**相对**路径,迁移后才不会断:

```bash
./dsh plugin --profile web add link:../../../workspace/my-plugin
```

> `dsh plugin` 是转发给 pnpm 的,而 `@deepseek-ai/dsh` 并不捆绑 pnpm。
> 本构建器把它装了进去 —— 不然插件管理根本不可用。

## 快照

改插件的命令**自动**触发,平时也可以**手动**打。

```bash
./dsh-snap                      # 时间戳命名
./dsh-snap clean-baseline       # 自己命名 —— 永不被自动清理
./dsh-snap --list
./dsh-restore clean-baseline    # 不带参数会列出可用快照
```

| 入档 | 不入档 |
|---|---|
| `sessions/`、`settings.yaml`、`.credentials.yaml` | `profiles/*/node_modules`(可离线重建) |
| `profiles/*/package.json`、`pnpm-lock.yaml` | `logs/` |
| `workspace/` | `runtime/`、`app/` |

### 保留策略

自动快照命名为 `auto-<时间戳>`,保留最近 10 份,每次新建快照时清理更早的。
**手动命名的快照永不被清理。**

```bash
DSH_SNAPSHOT_KEEP=30 ./dsh plugin --profile web add foo   # 多留几份
DSH_AUTO_SNAPSHOT=0  ./dsh plugin --profile web add foo   # 跳过自动快照
```

恢复前请先停掉 DSH。

## 平台支持

✅ Linux x64/arm64(glibc) · Windows x64/arm64 · macOS x64/arm64

DSH 的 453 个依赖里只有 6 个绑平台,且都用 optionalDependencies 的变体模式:

| 家族 | Linux x64 | Linux arm64 | Win x64 | Win arm64 | macOS arm64 | musl | armv7 |
|---|---|---|---|---|---|---|---|
| koffi | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ❌ |
| sharp | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| @vscode/ripgrep | ✅ | ✅ | ✅ | ✅ | ✅ | n/a | ✅ |
| node-addon-require-builtin | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| landlock-run | ✅ | ✅ | — | — | — | — | — |

**不支持**:armv7、Alpine/musl。预编译 `.node` 另有 glibc 最低版本要求,
过老的发行版(CentOS 7)可能仍跑不起来 —— 未实测。

## 工作原理

```
探测 os/arch → 下载并校验 Node → 装「胖树」→ 按目标裁剪 → 组装 → 可移动性自检 → 打包
```

**胖树**:先装官方包,扫描出带 `os`/`cpu`/`libc` 字段的包,顺着父包的
`optionalDependencies` 找出同家族全部兄弟,再用 `npm install --force` 把所有平台
变体拉进一棵树。每个目标复制一份、裁掉不匹配的。多目标共用一次下载,树缓存在 `.cache/`。

### 为什么不需要 Rust

DSH 本体是纯 npm 包,Rust 只在编译 Tauri 原生壳时才用得上。本构建器用浏览器
app 模式当窗口 —— 这也是 DSH-Portable 自己在没有原生壳时的退路。因此不需要
rustc、webkit2gtk,也避开了最难的部分:交叉编译 Tauri(macOS 目标需要 Apple SDK,
Windows 需要 MSVC 链)。

### 引导层为什么是 sh + ps1 而不是 Python

引导层唯一的职责是「在什么都没有的机器上把 Node 弄下来」,所以只有一个问题重要:
这个解释器是不是随系统自带。

| | Linux | macOS | Windows | 零前置 |
|---|---|---|---|---|
| POSIX sh | ✅ | ✅ | ❌ | 是 |
| PowerShell | ❌ | ❌ | ✅ Win10+ | 是 |
| Python | ⚠️ 精简容器常缺 | ⚠️ 不预装 py3 | ❌ 不预装 | **否** |

Python 在三个平台上**都不保证存在**。而需要双写的只有那约 90 行引导 ——
`lib/build.mjs` 承载全部真实逻辑,本身就是跨平台的。

### 外部命令依赖

| 用途 | 依赖 |
|---|---|
| 解 `.tar.gz` | `tar`(三平台自带) |
| 解 `.zip` | Windows/macOS 用 bsdtar;Linux 需 `unzip` |
| 打 `.zip` | 无 —— 内置 `lib/zip.mjs` |
| 统计目录体积 | 无 —— Node 内完成 |

## 安全提醒

`data/dsh-home/.credentials.yaml` 是**明文** API 凭据。U 盘丢失等同凭据泄漏。
放上移动介质前请自行加密该文件,或从快照中排除、换机器后重新登录。

## 已知限制

- exFAT/FAT32 的 U 盘不支持符号链接。剩下那些链接全是 `.bin/` 下的 CLI shim,
  DSH 走 `node .../lib/bin.js` 直接调用,不受影响。
- Linux 与 Windows 之间迁移需要各构建一份。
- 上游适配风险自负 —— 没有第三方替你验证新版 DSH。升级前请打快照。

## 测试状态

Arch Linux x86_64 上以 `-t linux-x64,win-x64` 实测:

| 检查项 | 结果 |
|---|---|
| 自举 Node + SHA256 校验 | ✅ |
| 原生包裁剪 | linux 留 6/裁 55 · win 留 4/裁 57 |
| 可移动性自检 | linux 19 链接 · win 16 —— 全部相对 |
| 移动后 `./dsh --version` | ✅ `0.1.0-rc.8` |
| 移动后装插件 | ✅ 895ms,hoisted,1 个符号链接 |
| 改插件时自动快照 | ✅ 触发;`DSH_AUTO_SNAPSHOT=0` 可关 |
| 保留策略 | ✅ 保留 10 份自动快照,手动的不动 |
| `./dsh-restore` | ✅ 依赖离线重建,331ms |
| web 服务 | ✅ HTTP 200,`<title>DeepSeek Harness</title>` |
| 内置 ZIP 打包器 | ✅ `unzip -t` 无错,CRLF 正确 |

**未测试**:`build.ps1` 从未在 Windows 上运行过(开发机无 PowerShell);
macOS 与 Windows 产物只验证了布局与打包,未在真机启动;arm64 目标未构建过。

## 相关项目

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— 官方 DSH
- [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) —— 社区便携版,含 Tauri 原生壳
- [hairyf/deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop) —— Tauri 桌面端
- [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable) —— Windows 便携版

## 许可

MIT。DeepSeek Harness 及其名称、标志归 DeepSeek 所有;本项目为官方 npm 包的构建封装,
非官方制品。
