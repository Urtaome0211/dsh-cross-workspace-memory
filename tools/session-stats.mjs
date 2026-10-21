/**
 * 会话存档体检：解压本机所有 session.v4.jsonl.zstd，统计每个会话的回合数与
 * "上下文消息"被追加了几次。
 *
 * 用途：验证本插件的核心假设 —— 宿主的 runtime-context / time-context 是
 * **追加**进历史的（每次文本一变就再追加一条），不是替换，也不是只物化一次。
 * 所以注入放尾部不破坏前缀缓存；而注入文本如果每轮都变，就会每轮多付一次。
 *
 * 跑法：node tools/session-stats.mjs [最少回合数，默认 2]
 *
 * zstd 帧：一个文件里有多帧，Node 的 zstdDecompressSync 只解第一帧，
 * 所以要按魔数 28 B5 2F FD 切帧、逐帧解、再拼接。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import zlib from 'node:zlib'

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const minTurns = Number(process.argv[2] || 2)

function readZstd(file) {
  const buf = readFileSync(file)
  let off = 0
  const parts = []
  while (off < buf.length) {
    const next = buf.indexOf(MAGIC, off + 1)
    const end = next === -1 ? buf.length : next
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(off, end)))
    } catch {
      /* 非帧边界，跳过 */
    }
    off = end
  }
  return Buffer.concat(parts).toString('utf8')
}

const rows = []
for (const ws of readdirSync(sessionsRoot)) {
  const wsDir = join(sessionsRoot, ws)
  let entries
  try {
    entries = readdirSync(wsDir)
  } catch {
    continue
  }
  for (const s of entries) {
    const f = join(wsDir, s, 'session.v4.jsonl.zstd')
    let st
    try {
      st = statSync(f)
    } catch {
      continue
    }
    let text
    try {
      text = readZstd(f)
    } catch {
      continue
    }
    let turns = 0
    let runtimeCtx = 0
    let timeCtx = 0
    let lastSeq = 0
    for (const line of text.split('\n')) {
      if (!line) continue
      let r
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof r.seq === 'number' && r.seq > lastSeq) lastSeq = r.seq
      if (r.type === 'turn/start') turns++
      const kind = r.data && r.data.source && r.data.source.kind
      if (kind === 'runtime-context') runtimeCtx++
      if (kind === 'time-context') timeCtx++
    }
    if (turns >= minTurns) {
      rows.push({ ws: ws.slice(0, 30), turns, runtimeCtx, timeCtx, lastSeq, kb: Math.round(st.size / 1024) })
    }
  }
}

rows.sort((a, b) => b.turns - a.turns)
console.log(`多回合会话（turns >= ${minTurns}）：${rows.length} 个`)
console.log('turns  rc  tc  lastSeq    KB  workspace')
for (const r of rows) {
  console.log(
    String(r.turns).padStart(5),
    String(r.runtimeCtx).padStart(3),
    String(r.timeCtx).padStart(3),
    String(r.lastSeq).padStart(7),
    String(r.kb).padStart(5),
    r.ws,
  )
}
