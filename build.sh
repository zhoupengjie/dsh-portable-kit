#!/bin/sh
# DSH Portable 构建系统 —— 自举入口(POSIX sh)
#
# 唯一职责:探测本机 os/arch,把固定版 Node 拉到 .toolchain/ 里,
# 然后把控制权交给 lib/build.mjs。宿主机不需要预装 Node。
#
# 依赖:curl、tar(Linux 还需 xz)、shasum 或 sha256sum
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NODE_VERSION=${DSH_BUILD_NODE_VERSION:-v24.19.0}
NODE_MIRROR=${DSH_BUILD_NODE_MIRROR:-https://nodejs.org/dist}
# --cn 由 lib/build.mjs 解析,可自举早于它 —— 这里得自己认一次。否则最大的那个
# 下载(宿主 Node,约 50–90MB)仍走海外源,大陆用户加了 --cn 也照样卡在第一步。
# 显式设过 DSH_BUILD_NODE_MIRROR 的,以环境变量为准。
if [ -z "${DSH_BUILD_NODE_MIRROR:-}" ]; then
  case " $* " in
    *" --cn "*) NODE_MIRROR=https://npmmirror.com/mirrors/node ;;
  esac
fi
TOOLCHAIN="$ROOT/.toolchain"

# ── 探测宿主平台 ──────────────────────────────────────────────────────────
case "$(uname -s)" in
  Linux)   HOST_OS=linux ;;
  Darwin)  HOST_OS=darwin ;;
  MINGW*|MSYS*|CYGWIN*) HOST_OS=win ;;
  *) echo "Unsupported host OS: $(uname -s)" >&2; exit 2 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) HOST_ARCH=x64 ;;
  aarch64|arm64) HOST_ARCH=arm64 ;;
  *) echo "Unsupported host arch: $(uname -m)" >&2; exit 2 ;;
esac
HOST="$HOST_OS-$HOST_ARCH"

if [ "$HOST_OS" = win ]; then
  ARCHIVE="node-$NODE_VERSION-win-$HOST_ARCH.zip"
  NODE_BIN="$TOOLCHAIN/node-$NODE_VERSION-win-$HOST_ARCH/node.exe"
elif [ "$HOST_OS" = darwin ]; then
  ARCHIVE="node-$NODE_VERSION-darwin-$HOST_ARCH.tar.gz"
  NODE_BIN="$TOOLCHAIN/node-$NODE_VERSION-darwin-$HOST_ARCH/bin/node"
else
  ARCHIVE="node-$NODE_VERSION-linux-$HOST_ARCH.tar.xz"
  NODE_BIN="$TOOLCHAIN/node-$NODE_VERSION-linux-$HOST_ARCH/bin/node"
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ── 拉取并校验宿主 Node(已存在则跳过)─────────────────────────────────────
if [ ! -x "$NODE_BIN" ]; then
  echo "==> Bootstrap: downloading Node $NODE_VERSION ($HOST)"
  mkdir -p "$TOOLCHAIN/downloads"
  DL="$TOOLCHAIN/downloads/$ARCHIVE"
  [ -f "$DL" ] || curl --fail --location --retry 3 --progress-bar \
    --output "$DL" "$NODE_MIRROR/$NODE_VERSION/$ARCHIVE"

  # 用官方 SHASUMS256.txt 校验完整性
  SUMS="$TOOLCHAIN/downloads/SHASUMS256-$NODE_VERSION.txt"
  [ -f "$SUMS" ] || curl --fail --location --retry 3 --silent \
    --output "$SUMS" "$NODE_MIRROR/$NODE_VERSION/SHASUMS256.txt"
  WANT=$(awk -v f="$ARCHIVE" '$2 == f { print $1 }' "$SUMS")
  [ -n "$WANT" ] || { echo "$ARCHIVE not listed in SHASUMS256.txt" >&2; exit 1; }
  GOT=$(sha256_of "$DL")
  [ "$WANT" = "$GOT" ] || { echo "Node checksum mismatch: expected $WANT, got $GOT" >&2; rm -f "$DL"; exit 1; }
  echo "    Checksum OK ${WANT%"${WANT#????????}"}..."

  case "$ARCHIVE" in
    *.zip)     unzip -q "$DL" -d "$TOOLCHAIN" ;;
    *.tar.gz)  tar -xzf "$DL" -C "$TOOLCHAIN" ;;
    *.tar.xz)  tar -xJf "$DL" -C "$TOOLCHAIN" ;;
  esac
  [ -x "$NODE_BIN" ] || { echo "node still missing after extraction: $NODE_BIN" >&2; exit 1; }
fi

echo "==> Bootstrap done: $("$NODE_BIN" --version) ($HOST)"
exec "$NODE_BIN" "$ROOT/lib/build.mjs" --host "$HOST" "$@"
