/**
 * dsh-memory · Host 侧
 *
 * 目标：**跨工作区不掉记忆**。DSH 每个工作区是独立的会话目录，换工作区就等于换
 * 上下文；这里把事实/偏好/项目约定/决策理由/进度落到一个本机共享的存储里，
 * 再用两种方式喂回模型：
 *   1. 会话开头注入一份精简索引（systemPrompt.context，排在所有内置上下文之后）
 *      —— 只是一行一条的摘要，纯文本、确定性，进历史前缀后不再变，不破坏缓存；
 *   2. memory 工具：按需检索全文 / 写入 / 修改 / 删除。
 *
 * 另有自动捕获：每轮结束把「用户这句话 + 用了哪些工具 + 碰了哪些文件」记成一条
 * activity，于是新工作区里第一条索引就写着上个工作区做到哪。
 *
 * 反直觉但重要（探针实测，见 README）：宿主发现上下文文本变了，就会把整段
 * runtime-context 再追加一条到历史尾部（不替换旧的）。追加在尾部，前缀缓存不受影响，
 * 但那段文本要重新付一次 —— 所以注入文本要在一次会话里保持稳定：本会话自己写的
 * 进度条目不进索引（见 renderIndex 的 skipSession）。会话中途写入的新记忆，当前会话
 * 只能靠工具读到 —— 这是设计，不是缺陷。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { MemoryStore, formatItem, projectKey, projectName, renderIndex } from './store.js'

export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

const TOOL_NAME = 'memory'
/** 内置上下文（runtime-context / skill-catalog / time-context）之后的空位 */
const INDEX_ORDER = 9000

/** 工具返回：宿主只透传 ContentBlock[]，固定一个 text 块最省事 */
const output = {
  schema: { type: 'json' },
  render(_args, value) {
    return [{ type: 'text', text: String((value && value.text) || '') }]
  },
}

function textOfMessage(msg) {
  const parts = (msg && Array.isArray(msg.content)) ? msg.content : []
  return parts
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 从工具参数里抠"碰了哪些文件/命令"——只留短标识，够让人想起当时在干嘛 */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'file', 'notebook_path', 'target', 'cwd']
function digestArgs(rawArgs) {
  if (typeof rawArgs !== 'string' || rawArgs.length > 4000) return ''
  let args
  try {
    args = JSON.parse(rawArgs)
  } catch {
    return ''
  }
  if (!args || typeof args !== 'object') return ''
  for (const key of PATH_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) {
      const parts = v.replace(/\\/g, '/').split('/').filter(Boolean)
      return parts.length ? parts[parts.length - 1] : ''
    }
  }
  if (typeof args.command === 'string') {
    // 命令取"看起来像文件"的那个 token：cd / node / npm 这类首词没有信息量
    const m = args.command.match(/[\w./\\-]+\.(?:mjs|cjs|jsx|js|tsx|ts|json|py|md|ya?ml|sh|ps1|blend|toml|txt)\b/i)
    if (!m) return ''
    const parts = m[0].replace(/\\/g, '/').split('/').filter(Boolean)
    return (parts[parts.length - 1] || '').slice(0, 24)
  }
  return ''
}

function toolSummary(map) {
  return Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([k, n]) => (n > 1 ? k + '×' + n : k))
    .join(' ')
}

/** 一条 activity 的正文：用户那句 + 工具 + 文件 */
function activityText(st) {
  const tools = toolSummary(st.tools)
  const files = Array.from(st.files).slice(0, 4).join(' ')
  const bits = []
  if (st.user) bits.push(st.user.slice(0, 70))
  if (tools) bits.push('工具 ' + tools)
  if (files) bits.push('文件 ' + files)
  return bits.join(' · ')
}

export function apply(ctx, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const store = new MemoryStore(cfg.dir, { maxItems: cfg.maxItems })
  const capture = cfg.capture !== false
  const maxIndexChars = cfg.maxIndexChars
  const keepActivities = Number.isFinite(Number(cfg.keepActivities)) ? Number(cfg.keepActivities) : 3

  /* 落盘：debounce，避免每步工具调用都写盘；dispose 时兜底冲一次 */
  let timer = null
  const flush = () => {
    timer = null
    if (store.dirty) store.save()
  }
  const scheduleSave = () => {
    if (timer) return
    timer = setTimeout(flush, 1500)
    if (typeof timer.unref === 'function') timer.unref()
  }
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
    flush()
  }, 'dsh-memory: flush')

  // sessionId → cwd。workingDirectory 服务有时取不到（未声明的服务在 ctx 上是 undefined），
  // 而 session/event 里每个会话的 header.cwd 一定在，所以自己兜一张表。
  const cwdBySession = new Map()

  /* ── 1. 会话开头的索引注入 ─────────────────────────────────────────────── */
  try {
    const sp = ctx.get('systemPrompt')
    if (sp && typeof sp.context === 'function') {
      ctx.effect(() => sp.context({
        name: 'memory',
        order: INDEX_ORDER,
        // 同步、纯函数：同一份存储 ⇒ 同一段文本（缓存友好，见 store.js 顶部约束）
        // currentInitiator 用来跳过「本会话刚写的进度」——那几条每轮都在变，
        // 留在索引里会让注入文本每轮变一次，宿主就会每轮重发整段上下文。
        text: () => {
          let skip = ''
          try {
            skip = String(ctx.get?.('agents')?.currentInitiator?.()?.id || '')
          } catch {
            /* 取不到就不过滤，最坏退化成"每轮多几百字节" */
          }
          return renderIndex(store, { maxChars: maxIndexChars, skipSession: skip })
        },
      }), 'dsh-memory: index')
    } else {
      ctx.logger?.warn?.('[dsh-memory] systemPrompt.context 不可用：索引注入关闭，memory 工具仍可用')
    }
  } catch (e) {
    ctx.logger?.warn?.('[dsh-memory] 注册索引失败：' + String((e && e.message) || e))
  }

  /* ── 2. memory 工具 ───────────────────────────────────────────────────── */
  const wd = () => {
    try {
      return ctx.get?.('workingDirectory') || ctx.workingDirectory || null
    } catch {
      return null
    }
  }
  const cwdOf = async (exec) => {
    const agent = exec && exec.agent
    const svc = wd()
    if (agent && svc && typeof svc.ensure === 'function') {
      try {
        const p = await svc.ensure(agent)
        if (p) return String(p)
      } catch {
        /* agent 可能已结束，继续退 */
      }
    }
    if (agent) {
      const hit = cwdBySession.get(String(agent.id))
      if (hit) return hit
    }
    if (svc && svc.defaultDirectory) return String(svc.defaultDirectory)
    return ''
  }

  /** project 参数既收绝对路径，也收项目名（如 "SSLTool"）——名字按 projectName 反查 */
  const resolveProject = (input, fallback) => {
    const raw = String(input == null ? '' : input).trim()
    if (!raw) return { key: projectKey(fallback), path: fallback || '' }
    if (/[\\/]/.test(raw) || /^[a-zA-Z]:/.test(raw)) return { key: projectKey(raw), path: raw }
    const hit = store.items.find((it) => it.projectName.toLowerCase() === raw.toLowerCase())
    return hit ? { key: hit.projectKey, path: hit.projectKey } : { key: projectKey(raw), path: raw }
  }

  const row = (it) => '[' + it.id + '] ' + formatItem(it, { maxChars: 220 })

  try {
    ctx.effect(() => ctx.tools.register(defineTool({
      name: TOOL_NAME,
      description: '跨工作区长期记忆：本机所有工作区共享的持久笔记（偏好 / 事实 / 项目约定 / 决策理由 / 待办 / 上次进度）。'
        + '会话开头已自动注入一份一行一条的索引；索引只是摘要，要细节就 search 取全文，别凭索引猜。'
        + '换到新工作区、或要回忆"上次做到哪 / 当初为什么这么定"时用它。',
      parameters: {
        action: {
          type: 'string',
          description: 'search 检索 | save 写一条 | update 改 | forget 删 | list 列 | diagnostics 看注入索引原文。默认：给了 query 就 search，给了 text 就 save，给了 id 就 update',
        },
        query: { type: 'string', description: 'search 的关键词，中文整句也行（按二字组匹配，不需要精确措辞）' },
        text: { type: 'string', description: 'save/update 的内容：一句话写清事实本身与它的作用，200 字以内；决策要写"选了什么 + 为什么 + 当时的约束"' },
        kind: { type: 'string', description: '类别，默认 fact：preference 偏好 | fact 事实 | project 项目档案 | decision 决策 | todo 待办 | activity 进度' },
        tags: { type: 'json', description: '字符串数组，如 ["unity","打包"]；用于检索加权' },
        id: { type: 'string', description: '条目 id（search / list 回执里方括号中的那串）' },
        project: { type: 'string', description: '归属项目：绝对路径或项目名；默认当前工作区' },
        limit: { type: 'integer', description: '最多返回几条，默认 8（list 默认 20）' },
      },
      output,
      isConcurrencySafe: () => false,
      timeoutMs: 15000,
      async execute(args, exec) {
        const a = args && typeof args === 'object' ? args : {}
        let action = String(a.action || '').trim().toLowerCase()
        if (!action) action = a.query ? 'search' : a.text ? 'save' : a.id ? 'update' : 'list'

        const cwd = await cwdOf(exec)
        const proj = resolveProject(a.project, cwd)
        const where = proj.path ? projectName(proj.path) + '（' + proj.path + '）' : '(未知工作区)'

        if (action === 'save') {
          const r = store.upsert({
            text: a.text,
            kind: a.kind,
            tags: a.tags,
            project: proj.path,
            source: 'manual',
          })
          scheduleSave()
          return {
            text: (r.deduped ? '已更新已有条目（内容相同，原地合并）' : '已记下')
              + ' [' + r.item.id + '] · ' + formatItem(r.item, { maxChars: 400 })
              + '\n共 ' + store.items.length + ' 条 · ' + store.file,
          }
        }

        if (action === 'update') {
          if (!a.id) return { text: 'update 需要 id（先用 search 或 list 找到它）' }
          const it = store.update(a.id, { text: a.text, kind: a.kind, tags: a.tags, project: a.project ? proj.path : undefined })
          if (!it) return { text: '没找到 id=' + a.id + ' 的条目' }
          scheduleSave()
          return { text: '已更新 [' + it.id + '] · ' + formatItem(it, { maxChars: 400 }) }
        }

        if (action === 'forget') {
          if (!a.id) return { text: 'forget 需要 id（先用 search 或 list 找到它）' }
          const ok = store.remove(a.id)
          if (ok) scheduleSave()
          return { text: ok ? '已删除 [' + a.id + ']' : '没找到 id=' + a.id + ' 的条目' }
        }

        if (action === 'diagnostics') {
          let skip = ''
          try {
            skip = String(ctx.get?.('agents')?.currentInitiator?.()?.id || '')
          } catch {
            /* 取不到就当不过滤 */
          }
          const text = renderIndex(store, { maxChars: maxIndexChars, skipSession: skip })
          const st = store.stats()
          const lines = [
            'memory · 存储 ' + st.file,
            '条目 ' + st.total + ' · 索引注入 ' + (text ? '开（' + text.length + ' 字符）' : '关（无条目）'),
            '类别 ' + JSON.stringify(st.byKind),
            '项目 ' + JSON.stringify(st.byProject),
            '当前工作区 ' + (cwd || '(未解析)'),
            '本会话 id ' + (skip || '(未取到)') + '（本会话写的进度不进索引，避免每轮重发上下文）',
            store.loadError ? 'loadError ' + store.loadError : '',
            store.saveError ? 'saveError ' + store.saveError : '',
            '',
            '—— 实际注入的索引文本 ——',
            text || '(空：没有条目时注入会跳过，不占 token)',
          ].filter((x) => x !== '')
          return { text: lines.join('\n') }
        }

        store.refresh()
        const limit = a.limit
        const kind = a.kind
        const project = a.project ? proj.path : (a.query ? cwd : '')
        const hits = action === 'search'
          ? store.search(a.query, { kind, project, limit: limit || 8 })
          : store.list({ kind, project, limit: limit || 20 })

        if (!hits.length) {
          return {
            text: '没有命中。'
              + (action === 'search' ? '换个关键词（中文可整句），或用 list 看全部；' : '')
              + '当前存储 ' + store.items.length + ' 条 · ' + where,
          }
        }
        const head = action === 'search'
          ? 'memory search 「' + String(a.query || '') + '」 · ' + hits.length + ' 条 · 本工作区 ' + where
          : 'memory list · ' + hits.length + ' 条 · ' + where
        return { text: [head, ...hits.map(row)].join('\n') }
      },
    })), 'dsh-memory: tool')
  } catch (e) {
    ctx.logger?.warn?.('[dsh-memory] 注册 memory 工具失败：' + String((e && e.message) || e))
  }

  /* ── 3. 自动捕获：每轮结束记一条 activity ─────────────────────────────── */
  if (!capture) return

  const sess = new Map()

  const commit = (session, st) => {
    const trivial = !st.user || st.user.length < 4
    if (st.tools.size === 0 && (trivial || st.user.length < 12)) return
    const cwd = (session.header && session.header.cwd) || ''
    const text = activityText(st)
    if (!text || text.length < 8) return

    const key = projectKey(cwd)
    const r = store.upsert({ kind: 'activity', text, project: cwd, source: 'auto', sessionId: session.id })
    // 每个项目只留最近 keepActivities 条 —— 进度条目会无限长，索引只放得下几条
    const same = store.items
      .filter((it) => it.kind === 'activity' && it.projectKey === key)
      .sort((x, y) => y.updated - x.updated)
    for (const old of same.slice(keepActivities)) store.remove(old.id)
    if (!r.deduped || same.length > keepActivities) scheduleSave()
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      if (session.header && session.header.origin === 'subagent') return
      const sid = String(session.id)
      const sessCwd = (session.header && session.header.cwd) || ''
      if (sessCwd && cwdBySession.get(sid) !== sessCwd) cwdBySession.set(sid, sessCwd)
      let st = sess.get(sid)
      if (!st) {
        st = { user: '', tools: new Map(), files: new Set() }
        sess.set(sid, st)
      }
      if (event.type === 'user/message') {
        const src = event.data && event.data.source
        if (!src || src.kind !== 'user') return
        // 新一轮：重置本轮画像（同一轮里的后续 user 消息不该覆盖第一句）
        if (st.user) return
        st.user = textOfMessage(event.data)
        st.tools = new Map()
        st.files = new Set()
        return
      }
      if (event.type === 'tool/call') {
        const n = String((event.data && event.data.name) || '')
        if (!n) return
        st.tools.set(n, (st.tools.get(n) || 0) + 1)
        const f = digestArgs(event.data.arguments)
        if (f && st.files.size < 6) st.files.add(f)
        return
      }
      if (event.type === 'turn/end') {
        commit(session, st)
        sess.delete(sid)
      }
    } catch (e) {
      // 观察者出错绝不能影响会话提交；记一次就够了
      ctx.logger?.warn?.('[dsh-memory] capture 失败：' + String((e && e.message) || e))
    }
  }), 'dsh-memory: capture')
}
