/**
 * dsh-memory · 纯逻辑层：存储 / 检索 / 索引渲染
 *
 * 不依赖任何 DSH 宿主模块 —— 可以 `node test/store.test.mjs` 直接跑。
 *
 * 存储：<dir>/memory.json
 *   { version, updatedAt, items: Item[] }
 *   Item = { id, kind, text, tags[], projectKey, projectName, source, created, updated }
 *
 * 两条硬约束（改这里之前先读）：
 *  1. renderIndex() 必须**确定性**：同一份 items ⇒ 逐字节相同的文本。
 *     会话开头注入的 <memory> 块会进入历史前缀，文本一旦抖动，后续每轮的前缀缓存就废了
 *     —— 那正是这个插件要消灭的浪费。所以索引里只放绝对短日期（MM-DD），
 *     不出现"3 天前""刚刚"这类随当前时间漂移的措辞，也不放随机量。
 *  2. 单进程里的副本是权威；多实例并发时靠**文件内容比对**检测变化 + 按 id 合并（updated 大的胜出）。
 *     不用 mtime：CI 与网络盘的时间戳分辨率不可靠，连续两次写可能拿到相同的 mtime。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const STORE_VERSION = 1

/** 类别 = 注入索引里的标签，也是检索时的加权维度。顺序即索引优先级。 */
export const KINDS = ['preference', 'decision', 'project', 'fact', 'todo', 'activity']

const KIND_WEIGHT = { preference: 100, decision: 90, project: 85, fact: 70, todo: 60, activity: 40 }

const KIND_ALIAS = {
  偏好: 'preference', preference: 'preference', prefer: 'preference',
  决策: 'decision', decision: 'decision', why: 'decision',
  项目: 'project', project: 'project', repo: 'project',
  事实: 'fact', fact: 'fact', note: 'fact',
  待办: 'todo', todo: 'todo', task: 'todo',
  进度: 'activity', activity: 'activity', progress: 'activity',
}

/** `~/.dsh/memory`（可用 DSH_HOME 覆盖，与宿主其它数据同根） */
export function resolveDir(explicit) {
  if (explicit) return String(explicit)
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'memory')
}

export function storePath(dir) {
  return join(String(dir), 'memory.json')
}

export function normalizeKind(kind) {
  const k = String(kind == null ? '' : kind).trim().toLowerCase()
  return KIND_ALIAS[k] || (KINDS.includes(k) ? k : 'fact')
}

/** 项目键：统一分隔符 / 去尾斜杠 / 小写（Windows 大小写不敏感） */
export function projectKey(project) {
  if (!project) return ''
  return String(project).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 项目名：只做纯字符串切分，不用 path.basename。
 * 因为项目路径可能是另一个平台的写法（Windows 路径出现在 Linux 上，或反之），
 * 而 path.basename 只认当前平台的分隔符 —— 在 CI(Linux) 上会把
 * 'D:\\dshproject\\plugin' 原样返回。保留原始大小写。
 */
export function projectName(project) {
  if (!project) return ''
  const s = String(project).replace(/\\/g, '/').replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return i === -1 ? s : s.slice(i + 1)
}

function tidy(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
}

/** 去重的比较口径：忽略空白与标点 */
function normText(text) {
  return tidy(text).toLowerCase().replace(/[\s,.;:!?'"`~()\[\]{}<>，。；：！？、“”‘’（）【】《》\-_/\\|]+/g, '')
}

function uniq(arr) {
  const out = []
  for (const v of arr || []) {
    const s = tidy(v)
    if (s && !out.includes(s)) out.push(s)
  }
  return out.slice(0, 16)
}

function num(v, fallback) {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function clip(s, max) {
  const t = String(s == null ? '' : s)
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

/** MM-DD（本地时区）—— 绝对日期，不随时间漂移 */
function shortDate(ms) {
  const d = new Date(num(ms, 0))
  if (!Number.isFinite(d.getTime())) return '??-??'
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function newId(seed) {
  const h = createHash('sha1').update(String(seed) + '|' + String(Date.now()) + '|' + String(Math.random())).digest('hex')
  return 'm' + h.slice(0, 8)
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null
  const text = tidy(raw.text)
  if (!text) return null
  const project = raw.projectKey || raw.project || ''
  const created = num(raw.created, Date.now())
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id : newId(text),
    kind: normalizeKind(raw.kind),
    text,
    tags: uniq(Array.isArray(raw.tags) ? raw.tags : []),
    projectKey: projectKey(project),
    projectName: raw.projectName ? String(raw.projectName) : projectName(project),
    source: raw.source === 'auto' ? 'auto' : 'manual',
    created,
    updated: num(raw.updated, created),
  }
}

/** 索引排序：权重高的在前，同级按更新时间倒序，最后用 id 兜底 —— 保证全序、无歧义 */
function cmpIndex(a, b) {
  const wa = KIND_WEIGHT[a.kind] || 0
  const wb = KIND_WEIGHT[b.kind] || 0
  if (wa !== wb) return wb - wa
  if (b.updated !== a.updated) return b.updated - a.updated
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/* ── 检索打分 ─────────────────────────────────────────────────────────────── */

/**
 * 分词：英文/数字按词，中文按二元组（BM25 那套在几十条量级上不值得）。
 * "证书链校验" ⇒ 证书/书链/链校/校验 + 首四字，够命中任意子串。
 */
export function tokenize(s) {
  const out = new Set()
  const low = String(s == null ? '' : s).toLowerCase()
  for (const m of low.matchAll(/[a-z0-9_@.#+$-]{2,}/g)) out.add(m[0])
  const cjk = low.replace(/[^\u4e00-\u9fff]+/g, ' ')
  for (const seg of cjk.split(' ')) {
    if (!seg) continue
    if (seg.length <= 2) out.add(seg)
    else for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2))
  }
  return out
}

function scoreItem(item, qTokens, qLower, ctx) {
  const hay = (item.text + ' ' + item.tags.join(' ') + ' ' + item.projectName).toLowerCase()
  let hit = 0
  let s = 0
  for (const t of qTokens) {
    if (hay.includes(t)) {
      hit += 1
      s += t.length >= 3 ? 3 : 2
    }
  }
  if (!hit) return 0
  s += (hit / qTokens.size) * 6
  if (qLower.length >= 2 && hay.includes(qLower)) s += 5
  if (ctx.kind && item.kind === ctx.kind) s += 4
  if (ctx.projectKey && item.projectKey === ctx.projectKey) s += 6
  s += (KIND_WEIGHT[item.kind] || 0) / 100
  s += Math.max(0, 2 - (Date.now() - item.updated) / 86400000 / 14)
  return s
}

/* ── 存储 ─────────────────────────────────────────────────────────────────── */

export class MemoryStore {
  constructor(dir, opts = {}) {
    this.dir = resolveDir(dir)
    this.file = storePath(this.dir)
    this.maxItems = clamp(num(opts.maxItems, 400), 20, 5000)
    this.items = []
    this.raw = null
    this.mtime = 0
    this.dirty = false
    this.loadError = ''
    this.saveError = ''
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return this
      const st = statSync(this.file)
      const raw = readFileSync(this.file, 'utf8')
      const data = JSON.parse(raw)
      this.raw = raw
      this.mtime = st.mtimeMs
      const list = Array.isArray(data && data.items) ? data.items : []
      this.items = list.map(normalizeItem).filter(Boolean)
    } catch (e) {
      this.items = []
      this.loadError = String((e && e.message) || e)
    }
    return this
  }

  /**
   * 别的实例写过文件就并进来：以磁盘为准，本地更新的同 id 条目胜出。
   * 不传播删除 —— 两个实例同时增删属于极端情况，这里宁可多留一条也不要丢数据。
   *
   * 变更检测**不用 mtime**：CI / 网络盘上时间戳分辨率可能很粗，连续两次写会
   * 拿到相同的 mtime，于是「文件变了」被判成「没变」（Windows CI 上实测踩到）。
   * 改成比较文件内容本身，精确且跨平台。文件只有几十 KB，多读一次的代价可以忽略。
   */
  refresh() {
    try {
      if (!existsSync(this.file)) return false
      const raw = readFileSync(this.file, 'utf8')
      if (raw === this.raw) return false
      const data = JSON.parse(raw)
      const incoming = (Array.isArray(data && data.items) ? data.items : []).map(normalizeItem).filter(Boolean)
      const byId = new Map()
      for (const it of incoming) byId.set(it.id, it)
      for (const it of this.items) {
        const cur = byId.get(it.id)
        if (!cur || it.updated > cur.updated) byId.set(it.id, it)
      }
      this.items = Array.from(byId.values())
      this.raw = raw
      try {
        this.mtime = statSync(this.file).mtimeMs
      } catch {
        /* 只是诊断信息 */
      }
      this.trim()
      return true
    } catch (e) {
      this.loadError = String((e && e.message) || e)
      return false
    }
  }

  save() {
    try {
      mkdirSync(this.dir, { recursive: true })
      const body = JSON.stringify({ version: STORE_VERSION, updatedAt: Date.now(), items: this.items })
      const tmp = this.file + '.' + String(process.pid) + '.tmp'
      writeFileSync(tmp, body, 'utf8')
      renameSync(tmp, this.file)
      this.raw = body
      try {
        this.mtime = statSync(this.file).mtimeMs
      } catch {
        /* mtime 只用于诊断，拿不到不影响正确性 */
      }
      this.dirty = false
      this.saveError = ''
      return true
    } catch (e) {
      this.saveError = String((e && e.message) || e)
      return false
    }
  }

  /** 标记待落盘；真正的写由调用方 debounce（避免每步工具调用都 fsync） */
  touch() {
    this.dirty = true
    return this
  }

  trim() {
    if (this.items.length <= this.maxItems) return this
    const sorted = this.items.slice().sort((a, b) => {
      const wa = a.kind === 'activity' ? 0 : (KIND_WEIGHT[a.kind] || 0)
      const wb = b.kind === 'activity' ? 0 : (KIND_WEIGHT[b.kind] || 0)
      if (wa !== wb) return wa - wb
      return a.updated - b.updated
    })
    const drop = new Set(sorted.slice(0, this.items.length - this.maxItems).map((it) => it.id))
    this.items = this.items.filter((it) => !drop.has(it.id))
    return this
  }

  /** 写入 / 去重更新。返回 { item, deduped } */
  upsert(input = {}) {
    const text = tidy(input.text)
    if (!text) throw new Error('text 不能为空')
    const kind = normalizeKind(input.kind)
    const now = Date.now()
    const project = input.project || input.projectKey || ''
    const pk = projectKey(project)

    const norm = normText(text)
    const dup = this.items.find((it) => normText(it.text) === norm)
    if (dup) {
      dup.updated = now
      dup.kind = kind
      if (pk) {
        dup.projectKey = pk
        dup.projectName = projectName(project)
      }
      if (Array.isArray(input.tags) && input.tags.length) dup.tags = uniq([...dup.tags, ...input.tags])
      if (input.sessionId) dup.sessionId = String(input.sessionId)
      this.touch()
      return { item: dup, deduped: true }
    }

    const item = {
      id: newId(text + '|' + kind),
      kind,
      text,
      tags: uniq(input.tags || []),
      projectKey: pk,
      projectName: pk ? projectName(project) : '',
      source: input.source === 'auto' ? 'auto' : 'manual',
      sessionId: input.sessionId ? String(input.sessionId) : '',
      created: now,
      updated: now,
    }
    this.items.push(item)
    this.trim()
    this.touch()
    return { item, deduped: false }
  }

  update(id, patch = {}) {
    const it = this.items.find((x) => x.id === String(id))
    if (!it) return null
    if (patch.text !== undefined) {
      const text = tidy(patch.text)
      if (!text) throw new Error('text 不能为空')
      it.text = text
    }
    if (patch.kind !== undefined) it.kind = normalizeKind(patch.kind)
    if (Array.isArray(patch.tags)) it.tags = uniq(patch.tags)
    if (patch.project !== undefined) {
      it.projectKey = projectKey(patch.project)
      it.projectName = it.projectKey ? projectName(patch.project) : ''
    }
    it.updated = Date.now()
    this.touch()
    return it
  }

  remove(id) {
    const i = this.items.findIndex((x) => x.id === String(id))
    if (i < 0) return false
    this.items.splice(i, 1)
    this.touch()
    return true
  }

  get(id) {
    return this.items.find((x) => x.id === String(id)) || null
  }

  list(opts = {}) {
    const limit = clamp(num(opts.limit, 20), 1, 200)
    const pk = projectKey(opts.project)
    const kind = opts.kind ? normalizeKind(opts.kind) : ''
    return this.items
      .filter((it) => (!kind || it.kind === kind) && (!pk || it.projectKey === pk))
      .sort(cmpIndex)
      .slice(0, limit)
  }

  search(query, opts = {}) {
    const limit = clamp(num(opts.limit, 8), 1, 50)
    const q = tidy(query)
    if (!q) return this.list({ ...opts, limit })
    const qTokens = tokenize(q)
    const ctx = { kind: opts.kind ? normalizeKind(opts.kind) : '', projectKey: projectKey(opts.project) }
    const scored = []
    for (const it of this.items) {
      const s = scoreItem(it, qTokens, q.toLowerCase(), ctx)
      if (s > 0) scored.push({ it, s })
    }
    scored.sort((a, b) => b.s - a.s || cmpIndex(a.it, b.it))
    return scored.slice(0, limit).map((x) => x.it)
  }

  stats() {
    const byKind = {}
    const byProject = {}
    for (const it of this.items) {
      byKind[it.kind] = (byKind[it.kind] || 0) + 1
      const key = it.projectName || '(无项目)'
      byProject[key] = (byProject[key] || 0) + 1
    }
    return { total: this.items.length, byKind, byProject, file: this.file, dir: this.dir }
  }
}

/* ── 渲染 ─────────────────────────────────────────────────────────────────── */

const KIND_LABEL = {
  preference: '偏好',
  decision: '决策',
  project: '项目',
  fact: '事实',
  todo: '待办',
  activity: '进度',
}

/** 单条记录的一行文本（工具回执与注入索引共用同一口径） */
export function formatItem(item, opts = {}) {
  const max = clamp(num(opts.maxChars, 150), 20, 4000)
  const where = item.projectName ? item.projectName + ' · ' : ''
  const when = shortDate(item.kind === 'activity' ? item.created : item.updated)
  return '- [' + (KIND_LABEL[item.kind] || item.kind) + '] ' + where + clip(item.text, max) + '（' + when + '）'
}

/**
 * 会话开头注入的索引块。返回 '' 表示没有记忆可注入（此时宿主不会插入空块）。
 * 确定性：只依赖 items 的内容与排序，不看 Date.now()。
 */
export function renderIndex(store, opts = {}) {
  const maxChars = clamp(num(opts.maxChars, 1600), 200, 20000)
  const maxActivities = clamp(num(opts.maxActivities, 3), 0, 20)
  const skipSession = opts.skipSession ? String(opts.skipSession) : ''
  let items = (store && store.items) || []
  if (!items.length) return ''

  // 进度条目每轮都在变。宿主发现上下文文本变了，就会把整段 runtime-context 再追加一次；
  // 于是「每轮写一条进度」会把注入变成每轮 +1KB 的重复内容。本会话自己刚记的进度对模型
  // 没有信息量（就在对话里），跳过它们，索引在一次会话里就基本不动。
  if (skipSession) {
    items = items.filter((it) => !(it.kind === 'activity' && it.sessionId === skipSession))
  }
  if (!items.length) return ''

  const head = [
    '<memory 跨工作区记忆 · ' + String(items.length) + ' 条 · 本机所有工作区共享>',
    '以下是对本机其它工作区 / 更早会话的持久记录，可能已过时：与本会话亲眼所见冲突时，以本会话为准。',
  ]
  const sorted = items.slice().sort(cmpIndex)
  const lines = []
  let used = head.join('\n').length
  let acts = 0
  for (const it of sorted) {
    if (it.kind === 'activity' && acts >= maxActivities) continue
    const line = formatItem(it, { maxChars: 120 })
    if (used + line.length + 1 > maxChars) break
    if (it.kind === 'activity') acts++
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  const tail = [
    '需要细节用 memory(action="search", query="…") 检索全文；发现新事实用 memory(action="save", kind="fact|preference|project|decision|todo", text="…") 记一条。',
  ]
  return head.concat(lines, tail).join('\n')
}
