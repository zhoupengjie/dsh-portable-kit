# dsh-portable-kit

**构建真正可移动的 DeepSeek Harness —— 一个文件夹,能拷进 U 盘,能 30 毫秒打快照,插件把它搞崩了能立刻回滚。**

[English](./README.md)

```bash
# Linux / macOS
./build.sh && cd out/DSH-Portable-linux-x64 && ./start
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\build.ps1
cd out\DSH-Portable-win-x64 ; .\start.cmd
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
| Linux | `curl`、`tar`(构建 Windows 目标时还需 `bsdtar` **或** `unzip`,多数发行版自带其一) |
| macOS | `curl`、`tar` —— 系统自带 |
| Windows | PowerShell 5.1+ —— Win10/11 自带。只能构建 Windows 目标,见[交叉构建](#交叉构建) |

Node.js 由构建器自动下载并做 SHA256 校验。不往系统里装任何东西,工具链全在 `.toolchain/`。

## 用法

参数加在入口脚本上 —— Linux/macOS 是 `build.sh`,Windows 是 `build.ps1`。
两者都把参数**原样**转交给 `lib/build.mjs`,所以各平台写法完全一致。
注意用下面这套长/短选项,**不要**用 PowerShell 风格的 `-Targets`。

| 选项 | 说明 |
|---|---|
| `-t, --targets <列表>` | 目标平台,逗号分隔,或 `all`。默认宿主平台 |
| `-d, --dsh-version <版本>` | `latest` / `next` / `0.1.1-rc.1`。默认 `latest` |
| `--pnpm-version <版本>` | pnpm 版本(默认 `11.7.0`) |
| `--node-version <版本>` | Node 版本(默认 `v24.19.0`) |
| `--registry <地址>` | npm registry |
| `--node-mirror <地址>` | Node 下载源 |
| `--cn` | 一键切到 npmmirror —— 自举层与 `build.mjs` **各读一次** |
| `--libc <glibc\|musl>` | Linux 目标的 libc(默认 `glibc`) |
| `-o, --out <目录>` | 输出目录(默认 `./out`) |
| `--fresh` | 忽略缓存的运行时树,强制重新安装 |

可选目标:`linux-x64` `linux-arm64` `darwin-x64` `darwin-arm64` `win-x64` `win-arm64`

```bash
# Linux / macOS
./build.sh -t all                              # 全平台
./build.sh -t linux-x64,win-x64 -d 0.1.1-rc.1
./build.sh --cn                                # 国内镜像
```

```powershell
# Windows —— .\build.ps1 之后的才是给构建器的;
# -ExecutionPolicy 和 -File 是给 powershell.exe 本身的
powershell -ExecutionPolicy Bypass -File .\build.ps1 -t win-x64 -d 0.1.1-rc.1
powershell -ExecutionPolicy Bypass -File .\build.ps1 --cn
```

### 中国大陆:用国内镜像

加 `--cn` 就够了 —— registry、目标 Node 运行时、以及自举阶段的宿主 Node,三处全部走 npmmirror:

```bash
# Linux / macOS
./build.sh --cn
```

```powershell
# Windows
powershell -ExecutionPolicy Bypass -File .\build.ps1 --cn
```

自举层(`build.sh` / `build.ps1`)会**自己**认一次 `--cn`。这一步必须单独处理:它要先把
宿主 Node 拉下来,才有 Node 去跑 `lib/build.mjs`,而 `--cn` 是 `build.mjs` 的参数 ——
那时还轮不到它。偏偏这是整个构建里最大的一个下载(约 50–90MB),漏掉它 `--cn` 就没什么意义。

想换成别的源,用环境变量,优先级高于 `--cn`:

| 环境变量 | 作用 | 默认值 |
|---|---|---|
| `DSH_BUILD_NODE_MIRROR` | **自举**阶段下载宿主 Node 的源 | `https://nodejs.org/dist` |
| `DSH_BUILD_REGISTRY` | npm registry(等价于 `--registry`) | `https://registry.npmjs.org/` |
| `DSH_BUILD_NODE_VERSION` | 钉死的 Node 版本 | `v24.19.0` |

镜像不会削弱完整性校验:构建器照样下载 `SHASUMS256.txt` 并逐个核对 SHA256,对不上就
删掉下载文件并中止。实测 npmmirror 的 `SHASUMS256.txt` 与 `nodejs.org` **逐字节一致**
(例如 `node-v24.19.0-win-x64.zip` 两边都是 `57f71ab3652e…`),dist-tags 也同步。

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

以上是**目标**平台。某台机器能构建其中哪些是另一个问题 —— 见[交叉构建](#交叉构建)。

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
探测 os/arch → 下载并校验 Node → 装「胖树」→ 按目标裁剪 → 组装 → 可移动性自检
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
| 解 `.zip` | Windows/macOS 的 `tar` 就是 bsdtar;Linux 用 `bsdtar` 或 `unzip` |
| 统计目录体积 | 无 —— Node 内完成 |

## 交叉构建

POSIX 宿主可以构建全部目标;Windows 宿主只能构建 Windows 目标。

| 宿主 ↓ / 目标 → | `linux-*` | `darwin-*` | `win-*` |
|---|---|---|---|
| Linux | ✅ | ✅ | ✅ |
| macOS | ✅ | ✅ | ✅ |
| Windows | ❌ 拒绝 | ❌ 拒绝 | ✅ |

这个不对称来自 NTFS,不是偷懒。Windows 宿主打 POSIX 目标时有两处会坏,而且都
无法通过外部命令绕开:

- **没有可执行位。** Windows 上 `fs.chmod` 只切换只读属性,而系统自带的 bsdtar
  NTFS 根本没有这个概念,组装出的目录里所有文件都是 `0644` ——
  拷到目标机后连 `runtime/node/bin/node` 都是 `Permission denied`。
- **建不了符号链接。** 官方 Linux / macOS 版 Node 压缩包里的 `bin/npm`、`bin/npx`、
  `bin/corepack` 都是符号链接,非管理员的 Windows 进程创建不了。构建器会按链接
  目标的内容复制成普通文件来兜底(它们都是 `#!/usr/bin/env node` 脚本,复制后
  行为一致)—— 但这只解决解压,解决不了上面的可执行位。

这种产物构建时退出码是 0,坏在**使用**的时候,所以构建器直接在参数校验阶段拒绝。
POSIX 目标请在 POSIX 宿主上构建,WSL 就够:

```bash
wsl -- sh ./build.sh -t linux-x64
```

反方向是完全支持的:Linux 宿主产出的 Windows 包可以直接运行,`.bin/` 除外(见下)。

`app/node_modules/.bin` 里永远是**宿主**那一套 shim —— POSIX 宿主产出符号链接,
Windows 宿主产出 `.cmd`/`.ps1`。它是退化组件:启动器按路径直接调用 `lib/bin.js`
与 `pnpm.cjs`,`PATH` 加的是包根目录而不是 `.bin`。实测把 `.bin` 整个删掉,
`dsh`、`pnpm`、`dsh plugin` 照常工作,所以交叉构建的包不受影响。

## 安全提醒

`data/dsh-home/.credentials.yaml` 是**明文** API 凭据。U 盘丢失等同凭据泄漏。
放上移动介质前请自行加密该文件,或从快照中排除、换机器后重新登录。

## 已知限制

- exFAT/FAT32 的 U 盘不支持符号链接。剩下那些链接全是 `.bin/` 下的 CLI shim,
  DSH 走 `node .../lib/bin.js` 直接调用,不受影响。
- Windows 宿主只能构建 Windows 目标 —— 见[交叉构建](#交叉构建)。
- Linux 与 Windows 之间迁移需要各构建一份。
- 上游适配风险自负 —— 没有第三方替你验证新版 DSH。升级前请打快照。

## 测试状态

### Linux 宿主 —— Arch x86_64,`-t linux-x64,win-x64`

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

### Windows 宿主 —— Windows 11 x64,PowerShell 5.1,`-t win-x64`

| 检查项 | 结果 |
|---|---|
| `build.ps1` 自举 + SHA256 | ✅ |
| 参数透传 | ✅ `-t` `-d` `-o` `--targets` 均能到达 `build.mjs` |
| npm 安装 | ✅ 451 个包 / 20 分钟(主要耗时是 Defender 扫描) |
| 原生包裁剪 | ✅ 留 4/裁 55 |
| 可移动性自检 | ✅ 0 个符号链接 —— Windows 上 npm 产出 `.cmd`/`.ps1` shim |
| `dsh.cmd --version` | ✅ `0.1.0-rc.7` |
| `pnpm.cmd --version` | ✅ `11.7.0` —— 是包内那份,不是全局安装的 |
| `dsh-snap.cmd` 建/列快照 | ✅ |
| POSIX 目标 | ✅ 参数校验阶段即拒绝(见[交叉构建](#交叉构建)) |

### 交叉构建:Linux 宿主 → Windows 目标,已在真机 Windows 验证

Arch 上 `./build.sh -t win-x64` 产出的目录,拷到 Windows 11:

| 检查项 | 结果 |
|---|---|
| `.cmd` 换行符 | ✅ 32 个 CRLF,0 个裸 LF |
| `dsh.cmd --version` | ✅ `0.1.0-rc.7` |
| `pnpm.cmd --version` | ✅ `11.7.0` |
| `dsh.cmd plugin list` | ✅ 转发 pnpm,profile 初始化成功 |
| 裁剪正确性 | ✅ 恰好保留 4 个 `win32-x64` 原生包 |
| web 服务 | ✅ HTTP 200,`<title>DeepSeek Harness</title>` |
| `.bin` 形态 | ⚠️ 16 个被解引用的符号链接,无 `.cmd` —— 用不到,不影响 |

**未测试**:macOS 真机;arm64 目标真机;`start.cmd` 的拉起浏览器那段(服务本身已覆盖)。

## 相关项目

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) —— 官方 DSH
- [WSL043/DSH-Portable](https://github.com/WSL043/DSH-Portable) —— 社区便携版,含 Tauri 原生壳
- [hairyf/deepseek-harness-desktop](https://github.com/hairyf/deepseek-harness-desktop) —— Tauri 桌面端
- [sqs404/dsh-portable](https://github.com/sqs404/dsh-portable) —— Windows 便携版

## 许可

MIT。DeepSeek Harness 及其名称、标志归 DeepSeek 所有;本项目为官方 npm 包的构建封装,
非官方制品。
