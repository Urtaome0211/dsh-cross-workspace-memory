/**
 * store.js 的单元测试（不碰宿主，node test/store.test.mjs 直接跑）
 * 重点守住三条：确定性索引、中文检索、去重与裁剪。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MemoryStore,
  formatItem,
  normalizeKind,
  projectKey,
  projectName,
  renderIndex,
  resolveDir,
  tokenize,
} from '../lib/store.js'

const TMP = join(import.meta.dirname, '..', '.tmp')
mkdirSync(TMP, { recursive: true })

function freshStore(opts = {}) {
  return new MemoryStore(mkdtempSync(join(TMP, 'case-')), opts)
}

test('项目键：反斜杠/尾斜杠/大小写归一', () => {
  assert.equal(projectKey('D:\\dshproject\\plugin\\'), 'd:/dshproject/plugin')
  assert.equal(projectKey('D:/dshproject/plugin'), 'd:/dshproject/plugin')
  assert.equal(projectKey(''), '')
  assert.equal(projectName('D:\\dshproject\\plugin'), 'plugin')
  assert.equal(projectName(''), '')
})

test('项目名：跨平台路径都能取到末段（不能依赖 path.basename）', () => {
  // Windows 写法在 Linux 上、POSIX 写法在 Windows 上，都必须切得出来
  assert.equal(projectName('D:\\dshproject\\plugin\\'), 'plugin')
  assert.equal(projectName('D:/dshproject/plugin'), 'plugin')
  assert.equal(projectName('/home/runner/work/proj'), 'proj')
  assert.equal(projectName('/home/runner/work/proj/'), 'proj')
  assert.equal(projectName('C:\\Users\\me\\Documents\\Game'), 'Game') // 大小写保留
  assert.equal(projectName('单段项目名'), '单段项目名')
  assert.equal(projectName('/'), '')
})

test('类别别名与兜底', () => {
  assert.equal(normalizeKind('偏好'), 'preference')
  assert.equal(normalizeKind('DECISION'), 'decision')
  assert.equal(normalizeKind('胡说'), 'fact')
  assert.equal(normalizeKind(undefined), 'fact')
})

test('写入 / 读取 / 更新 / 删除 / 落盘往返', () => {
  const s = freshStore()
  const a = s.upsert({ kind: 'fact', text: 'SSLTool 用 mkcert 生成根证书', project: 'D:/w/SSLTool' })
  assert.equal(a.deduped, false)
  assert.equal(s.items.length, 1)
  assert.equal(a.item.projectName, 'SSLTool')

  assert.equal(s.save(), true)
  const again = new MemoryStore(s.dir)
  assert.equal(again.items.length, 1)
  assert.equal(again.items[0].text, 'SSLTool 用 mkcert 生成根证书')
  assert.equal(again.get(a.item.id).kind, 'fact')

  const up = again.update(a.item.id, { kind: 'decision', text: '选 mkcert 而不是自签脚本：少装依赖' })
  assert.equal(up.kind, 'decision')
  assert.equal(again.items.length, 1)
  assert.equal(again.remove(a.item.id), true)
  assert.equal(again.remove('nope'), false)
  assert.equal(again.items.length, 0)
})

test('去重：同文本只留一条并刷新时间', () => {
  const s = freshStore()
  const a = s.upsert({ kind: 'fact', text: 'Windows 上 pnpm 要放 D 盘' })
  const b = s.upsert({ kind: 'fact', text: '  windows 上 pnpm 要放 d 盘。 ' })
  assert.equal(b.deduped, true)
  assert.equal(s.items.length, 1)
  assert.equal(a.item.id, b.item.id)
  assert.ok(b.item.updated >= a.item.updated)
})

test('中文检索：整句也能命中（二字组）', () => {
  const s = freshStore()
  s.upsert({ kind: 'project', text: 'SSLTool 用 mkcert 生成根证书，证书链校验走 openssl', tags: ['ssl'] })
  s.upsert({ kind: 'preference', text: '回答用中文，先给结论再给依据' })
  s.upsert({ kind: 'decision', text: 'Blender 建模一律先冻结 spec 再动手', tags: ['blender'] })

  assert.ok(tokenize('证书链校验').has('证书'))
  const hits = s.search('证书链怎么校验的')
  assert.equal(hits.length, 1)
  assert.match(hits[0].text, /mkcert/)

  assert.equal(s.search('blender spec').length, 1)
  assert.equal(s.search('中文结论')[0].kind, 'preference')
  assert.equal(s.search('完全不存在的词').length, 0)
})

test('检索排序：当前工作区的条目优先', () => {
  const s = freshStore()
  s.upsert({ kind: 'fact', text: '打包脚本用 build.sh', project: 'D:/w/A' })
  s.upsert({ kind: 'fact', text: '打包脚本用 build.sh（B 项目版）', project: 'D:/w/B' })
  const hits = s.search('打包脚本', { project: 'D:/w/B' })
  assert.equal(hits[0].projectKey, 'd:/w/b')
})

test('索引确定性：同一份存储两次渲染逐字节相同', () => {
  const s = freshStore()
  for (let i = 0; i < 6; i++) s.upsert({ kind: 'fact', text: '事实 ' + i, project: 'D:/w/P' + i })
  const a = renderIndex(s, { maxChars: 1600 })
  const b = renderIndex(s, { maxChars: 1600 })
  assert.equal(a, b)
  assert.match(a, /<memory 跨工作区记忆 · 6 条/)
  assert.match(a, /memory\(action="search"/)
})

test('索引确定性：不含会随时间漂移的措辞', () => {
  const s = freshStore()
  s.upsert({ kind: 'activity', text: '上次做到屋顶瓦片阵列', project: 'D:/w/house' })
  const text = renderIndex(s)
  assert.doesNotMatch(text, /刚刚|分钟前|小时前|天前|现在|今天|昨天/)
  assert.match(text, /昨|进|屋/) // 只断言正文在，不断言日期格式
})

test('索引预算：超长时截断而不是全量倒出', () => {
  const s = freshStore()
  for (let i = 0; i < 80; i++) {
    s.upsert({ kind: 'fact', text: '第 ' + i + ' 条很长的记忆内容，用来把索引撑爆'.repeat(3), project: 'D:/w/P' })
  }
  const text = renderIndex(s, { maxChars: 600 })
  assert.ok(text.length <= 600 + 120, '实际 ' + text.length)
  assert.match(text, /<memory/)
})

test('空存储不注入（返回空串，零 token）', () => {
  const s = freshStore()
  assert.equal(renderIndex(s), '')
})

test('裁剪：超上限先删最老的进度条目，再删低权重', () => {
  const s = freshStore({ maxItems: 20 })
  for (let i = 0; i < 40; i++) s.upsert({ kind: 'activity', text: '进度 ' + i })
  assert.equal(s.items.length, 20)
  assert.ok(s.items.every((it) => it.kind === 'activity'))

  for (let i = 0; i < 20; i++) s.upsert({ kind: 'preference', text: '偏好 ' + i })
  assert.equal(s.items.length, 20)
  assert.equal(s.items.filter((it) => it.kind === 'preference').length, 20)
})

test('多实例：refresh 合并外部新增且保留本地更新的同 id 条目', () => {
  const dir = mkdtempSync(join(TMP, 'case-'))
  const a = new MemoryStore(dir)
  a.upsert({ kind: 'fact', text: 'A 写的' })
  a.save()

  const b = new MemoryStore(dir)
  b.upsert({ kind: 'fact', text: 'B 写的' })
  b.save()

  assert.equal(a.refresh(), true)
  assert.equal(a.items.length, 2)
  assert.equal(a.refresh(), false) // mtime 没变 → 不重复合并
})

test('行文格式：带类别中文标签与日期', () => {
  const it = { id: 'm1', kind: 'decision', text: '选 A 因为 B', tags: [], projectKey: '', projectName: '', created: Date.now(), updated: Date.now() }
  const line = formatItem(it)
  assert.match(line, /^- \[决策\] 选 A 因为 B（\d\d-\d\d）$/)
})

test('坏文件不炸：解析失败当作空库并记下 loadError', () => {
  const dir = mkdtempSync(join(TMP, 'case-'))
  writeFileSync(join(dir, 'memory.json'), '{ 这不是 json', 'utf8')
  const s = new MemoryStore(dir)
  assert.equal(s.items.length, 0)
  assert.ok(s.loadError)
  s.upsert({ kind: 'fact', text: '恢复写入' })
  assert.equal(s.save(), true)
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).items.length, 1)
})

test('resolveDir 支持 DSH_HOME 覆盖', () => {
  const old = process.env.DSH_HOME
  process.env.DSH_HOME = 'D:/fake-home'
  try {
    assert.equal(resolveDir(), join('D:/fake-home', 'memory'))
    assert.equal(resolveDir('X:/y'), 'X:/y')
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
  }
})
