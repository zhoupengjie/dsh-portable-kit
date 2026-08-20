// 极简 ZIP 打包器(store + deflate)
//
// 为什么不调用外部 zip:`zip` 命令在 Windows 上根本不存在,在很多 Linux 发行版
// 上也不是默认安装(本项目开发机 Arch 上就没有)。而打 Windows 目标的产物又必须
// 出 .zip。用 Node 自带的 zlib 自己写,比要求用户先装工具更符合「通用构建器」。

import { deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const deflate = promisify(deflateRaw)

// CRC-32(ZIP 规范要求)
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (let i = 0; i < buffer.length; i += 1) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

// ZIP 用 MS-DOS 时间戳。固定为 1980-01-01 以保证可复现构建。
const DOS_DATE = 0x0021 // 1980-01-01
const DOS_TIME = 0x0000

async function collect(root, base = '', out = []) {
  for (const entry of (await readdir(path.join(root, base), { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push({ rel: `${rel}/`, dir: true })
      await collect(root, rel, out)
    } else if (entry.isSymbolicLink()) {
      // ZIP 存符号链接需要 Unix 扩展属性;Windows 解压端普遍不支持,
      // 这里按目标文件内容存成普通文件,避免解压出坏链接。
      const full = path.join(root, rel)
      out.push({ rel, dir: false, data: await readFile(full), mode: (await stat(full)).mode })
    } else {
      const full = path.join(root, rel)
      out.push({ rel, dir: false, data: await readFile(full), mode: (await stat(full)).mode })
    }
  }
  return out
}

/**
 * 把 sourceDir 打包成 zipPath,归档内顶层目录名为 sourceDir 的 basename。
 */
export async function zipDirectory(sourceDir, zipPath) {
  const prefix = path.basename(sourceDir)
  const entries = await collect(sourceDir)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(`${prefix}/${entry.rel}`, 'utf8')
    const raw = entry.dir ? Buffer.alloc(0) : entry.data
    const crc = entry.dir ? 0 : crc32(raw)
    // 目录与空文件用 store(方法 0),其余走 deflate;若压不小则退回 store
    let method = 0
    let payload = raw
    if (!entry.dir && raw.length > 0) {
      const packed = await deflate(raw, { level: 6 })
      if (packed.length < raw.length) { method = 8; payload = packed }
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)   // 本地文件头签名
    local.writeUInt16LE(20, 4)           // 解压所需版本 2.0
    local.writeUInt16LE(0x0800, 6)       // 位标志:文件名为 UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0) // 中央目录头签名
    central.writeUInt16LE(0x031e, 4)     // 生成方:Unix, 版本 3.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)         // extra
    central.writeUInt16LE(0, 32)         // comment
    central.writeUInt16LE(0, 34)         // 磁盘号
    central.writeUInt16LE(0, 36)         // 内部属性
    // 外部属性高 16 位放 Unix 权限,保住可执行位
    const unixMode = entry.dir ? 0o040755 : (entry.mode & 0o777) | 0o100000
    // 注意整体再 >>> 0:`|` 会把左移结果转回有符号 int32,直接写会越界
    central.writeUInt32LE((((unixMode & 0xffff) << 16) | (entry.dir ? 0x10 : 0)) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + payload.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)      // 中央目录结束记录
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralBuffer.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  await writeFile(zipPath, Buffer.concat([...locals, centralBuffer, eocd]))
}
