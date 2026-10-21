# 给 DeepSeek Harness 做一层跨工作区记忆：一次从「缓存玄学」到「上下文机制」的排查

> 一句话摘要：我原以为换个工作区就丢缓存、在白花 token，实测发现**缓存根本没坏**——丢掉的是对话里攒下的知识。于是我写了一个插件，在不打碎前缀缓存的前提下，把「上次做到哪、为什么这么定」喂回给下一个工作区。
>
> 关键词：DeepSeek Harness · 插件开发 · prompt 缓存 · 上下文注入 · 长期记忆
>
> 全文约 1.3 万字符（4 700 余汉字），含 5 段可直接抄的代码、3 张实测数据表、以及 6 个踩过的坑。

---

## 一、起念：一个关于「多花钱」的假设

我有六个活跃工作区：一个游戏工程、一个着色器玩具、一个建筑建模目录、一个流程工具、一个公司项目、还有一个插件目录。每个工作区开一个新会话，DeepSeek Harness（下文简称 DSH）都从零开始认识我：

- 构建用 `pnpm build` 还是 `npm run dist`；
- 这个仓库的约定是「不要动 `generated/` 下的文件」；
- 昨天那个坑——某个 API 的返回值不是无损 JSON，害我排查了半小时；
- 上次那个决定——为什么选了 A 方案而不是 B，当时的约束是什么。

于是很自然地冒出一个假设：

> **换个工作区，缓存就命不中了，同样的系统提示词被反复重新计费。**

这个假设听起来非常合理：缓存不就是按前缀匹配的吗？工作区路径变了，前缀不就变了吗？

它错得很彻底。而把它证伪的过程，恰好是后面所有设计的起点。

## 二、先证伪：缓存其实没坏

### 2.1 会话日志在哪、怎么读

DSH 把每个会话的事件流写成 zstd 压缩的 JSONL，按工作区目录分桶：

```
C:\Users\<you>\.dsh\sessions\--D-dshproject-Game--\session-<uuid>\session.v4.jsonl.zstd
```

难点在于：一个文件里是**多帧 zstd** 拼接（我那天的会话是 77 帧），而 Node 的 `zlib.zstdDecompressSync` 只解第一帧，直接调会得到一小段乱码般的截断内容。正确做法是按魔数 `28 B5 2F FD` 切帧、逐帧解、再拼接：

```js
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

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
      /* 不是合法的帧起点，跳过 */
    }
    off = end
  }
  return Buffer.concat(parts).toString('utf8')
}
```

这个小工具后来被我固化成 `tools/session-stats.mjs`，它现在是本文全部数据的来源。**先用数据说话，再谈设计**——这是整个项目最重要的一条纪律。

### 2.2 三个反直觉的事实

把会话摊开看之后，三件事和我原来的想象都不一样。

**事实一：系统提示词里没有工作区路径。**

我把解压出来的 system prompt 全文捞出来（7981 字符）逐行看过，它是**跨工作区完全一致**的。一个字节都没变，缓存凭什么失效？

**事实二：当前工作区路径是通过「历史消息」注入的。**

它在 `runtime-context` 这条用户侧消息里，出现在用户第一句话**之后**：

```jsonc
{ "role": "user", "source": { "kind": "runtime-context", "form": "snapshot" }, "content": [...] }
```

同类的还有 `skill-catalog`（技能目录）和 `time-context`（当前时间）。也就是说，会变的东西被刻意放在了**队列末尾**——这是所有想吃到前缀缓存的人都会做的事。

**事实三：我第一次请求就命中了缓存。**

```
第一条请求：cacheReadTokens 13.8K / 输入 27.7K
```

一半以上的输入是白拿的。所谓「换工作区就丢缓存」，从头到尾都不成立。

### 2.3 那到底丢了什么

丢的不是字节，是**知识**。

| 缓存能跨工作区保住 | 缓存保不住 |
| --- | --- |
| 系统提示词、工具定义、技能目录 | 这个项目里踩过的坑 |
| 任何与路径无关的静态前缀 | 为什么选 A 不选 B |
| | 上次改到哪个文件、卡在哪一步 |

所以真正该做的，不是「共享缓存」，而是**共享记忆**——并且做的时候必须保证不把已经吃到嘴的缓存饭打翻。

## 三、关键约束：注入位置决定生死

缓存的基本规则只有一条：**前缀稳定，尾部随意**。前缀里变一个字节，后面的全部作废。

于是注入位置只有三种选择，我逐一想了一遍：

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A | 改系统提示词，加一段记忆 | **自杀**。系统提示词一变，整个前缀全部作废，比不做还贵 |
| B | 在用户消息前插一条记忆 | 同样破坏了「历史前缀」，而且用户消息本身还会被改写 |
| C | 注册成一条 `systemPrompt.context`，排在所有内置上下文之后 | 只影响尾部 ✔ |

选了 C。具体就是宿主 API 的：

```js
const sp = ctx.get('systemPrompt')
ctx.effect(() => sp.context({
  name: 'memory',
  order: 9000,                       // 排在 runtime-context / skill-catalog / time-context 之后
  text: () => renderIndex(store, { maxChars: 1600, skipSession }),
}), 'dsh-memory: index')
```

### 3.1 一个必须搞清楚的细节：这段文本什么时候被「物化」

如果它只在会话开局渲染一次，那怎么变都无所谓。所以我做了个实验：统计 16 个多回合会话里，各类上下文消息在历史中出现了几次。

| 会话 | 回合数 | `time-context` 出现 | `runtime-context` 出现 | replace 操作 |
| --- | --- | --- | --- | --- |
| `--D-dshproject-Game--`（第 1 个） | 16 | 14 | 3 | 0 |
| 另一个 3 回合会话 | 3 | — | — | 0 |
| 我自己的会话 | 1 | 1 | 2（seq 25 与 seq 626） | 0 |

结论出乎意料：**宿主一旦发现上下文文本变了，就把整段 `runtime-context` 再追加一条到历史尾部**，旧的留在原地、不替换、不删除。

这带来两个直接推论：

1. **好消息**：追加在尾部，前缀缓存不受影响，随便变也不会打碎缓存。
2. **坏消息**：如果注入文本**每轮都变**（比如每轮自动记一条「刚做了什么」），那宿主就会每轮重发整段上下文，等于每轮多付一次 ~1KB。这恰恰是我这个插件最容易犯的错。

所以最终定下一条硬规矩，写进了 `lib/store.js` 的文件头注释：

> **索引文本必须在同一个存储状态下逐字节确定。**
> 日期只放绝对短日期（`10-21`），禁止「3 天前」「刚刚」这类会漂移的措辞；排序必须稳定；空库时返回空字符串（一条都不占）。

并且追加第二条：**本会话自己刚写进去的进度，不进索引**。理由是同一条——你刚写的进度会让文本每轮变一次。

```js
text: () => {
  let skip = ''
  try { skip = String(ctx.get('agents')?.currentInitiator?.()?.id || '') } catch {}
  return renderIndex(store, { maxChars: 1600, skipSession: skip })
}
```

## 四、设计：一份文件，三种喂回方式

用户当时给了四个选择，我请他把每个都勾了一遍：记忆内容要四类全要、注入要「混合」、写入要「自动 + 手动」、范围要「全工作区共享但打项目标签」。

于是我把它拆成三个组件。

### 4.1 数据模型：一条记忆是什么

```jsonc
{
  "id": "m8b3207b7",
  "kind": "project",              // preference | decision | project | fact | todo | activity
  "text": "构建用 pnpm build；打包走 electron-builder --dir 先看结构",
  "tags": ["构建", "打包"],
  "projectKey": "d:/dshproject/plugin",
  "projectName": "plugin",
  "source": "manual",             // manual | auto
  "sessionId": "session-…",       // 只对 activity 有意义
  "created": 1792584428250,
  "updated": 1792584602667
}
```

存储就是一个 JSON 文件：`~/.dsh/memory/memory.json`。

**为什么不用 SQLite？** 因为原生模块在 Electron 宿主里是部署负担，而这个量级（我设的上限是 400 条、几十 KB）用 `readFileSync` + `JSON.parse` 完全够，检索在内存里做完只用了不到 1 毫秒。

**为什么不用宿主自带的 `storageDomain`？** 它的 `DomainSpec` 要求每张表配一个 **zod** schema，等于给一个零依赖的小插件强塞一个依赖。我改成自己写文件 + 一个 `version` 字段留升级余地。

**多实例怎么办？** 桌面端可能的多个窗口同时写，所以 `load()` 记下 mtime，发现文件被改过就重读、**按 id 合并**（`updated` 大的胜出），并且写盘用 `tmp → rename` 保证原子性。删除不传播——这是有意的保守取舍：宁可多留一条，也不误删别人刚写的。

### 4.2 注入什么：索引的预算与排序

开局注入的是一个**索引**，不是全部记忆。默认上限 1600 字符，实际我这份库只有 600 多字符：

```
<memory 跨工作区记忆 · 3 条 · 本机所有工作区共享>
以下是对本机其它工作区 / 更早会话的持久记录，可能已过时：与本会话亲眼所见冲突时，以本会话为准。
- [项目] plugin · dsh-cross-workspace-memory 插件（原名 dsh-memory，因 npm 上该名已被 bbnopromo 的同用途包占用而改名）：跨工作区共享长期记忆…
- [进度] plugin · npm 注册被反机器人拦截（按出口 IP 判定），改走 tarball 分发；包名已就绪待发布。工具 ask_user_question ops_bash present（10-21）
- [进度] plugin · README 包名清查：标题、intro、tarball 文件名、示例行共 4 处漏改已补齐。工具 edit×5 grep×2 ops_bash read（10-21）
需要细节用 memory(action="search", query="…") 检索全文；发现新事实用 memory(action="save", …) 记一条。
```

三行设计意图值得说：

- **第二行是免责句**：「可能已过时，与本会话亲眼所见冲突时以本会话为准」。记忆最危险的失败模式不是缺失，而是**过期信息被当成事实**。这句话比任何去重逻辑都值钱。
- **第三行是工具提示**：让模型知道手里有检索工具、该怎么用。否则它只会看到三条摘要，然后继续瞎猜。
- **类别决定了谁能挤进预算**：`preference`(100) > `decision`(90) > `project`(85) > `fact`(70) > `todo`(60) > `activity`(40)。超预算时按权重从低到高丢，并且 `activity` 每个项目最多保留 3 条——所以长期项目不会把「偏好」挤出屏幕。

### 4.3 怎么取回：一个工具，七个动作

```js
{
  name: 'memory',
  parameters: {
    action: { type: 'string', description: 'search | save | update | forget | list | diagnostics' },
    query:  { type: 'string', description: '检索关键词（中文整句可直接传）' },
    text:   { type: 'string' },
    kind:   { type: 'string' },
    tags:   { type: 'json' },
    id:     { type: 'string' },
    project:{ type: 'string' },
    limit:  { type: 'number' }
  }
}
```

中文检索是这里唯一的算法活。没有分词器，也不该为它引一个依赖，所以用最朴素的**二字组**方案：把 `"上次打包报错怎么解决"` 拆成 `上次/次打/打包/包报/报错/…`，与记忆条目求交集。打分是「命中词数 × 类别权重 + 覆盖率 × 6 + 整串命中 +5 + 本工作区 +6 + 时效衰减」。

实测够用——「中文整句被检索到」这条我专门写了单元测试。它不是搜索质量的极限，但在「几十到几百条个人笔记」这个量级上，简单方案的可解释性比召回率更重要。

### 4.4 自动捕获：记「做了啥」，不冒充「学到啥」

自动捕获监听会话事件流，每个回合结束时落一条 `activity`：

```js
ctx.on('session/event', (session, event) => {
  if (session.header?.origin === 'subagent') return        // 子代理不记
  if (event.type === 'user/message' && event.data.source?.kind === 'user') {
    st.user ||= event.data.content.find(c => c.type === 'text')?.text?.slice(0, 70)
  }
  if (event.type === 'tool/call') { /* 统计工具名 + 提取文件 basename */ }
  if (event.type === 'turn/end') commit()                  // 1.5s 防抖写盘
})
```

产出形如（真实回执，非示意）：

```
[进度] plugin · README 包名清查：标题、intro、tarball 文件名、示例行共 4 处漏改已补齐。工具 edit×5 grep×2 ops_bash read（10-21）
```

这里还藏着第 6 个坑，是我自己用出来的。第一版的「文件」一栏取的是命令的**第一个单词**，于是自动捕获写出了这种东西：

```
[进度] plugin · (无提示词) · 工具 ops_bash×3 memory×2 · 文件 cd
```

`cd`、`node`、`npm` 全被当成文件名，而真正有用的 `store.test.mjs` 反而被丢掉。改成「从命令里挑第一个看起来像文件的 token」（必须有扩展名），噪声才消失：

```js
const m = args.command.match(/[\w./\\-]+\.(?:mjs|cjs|jsx|js|tsx|ts|json|py|md|ya?ml|sh|ps1|blend|toml|txt)\b/i)
if (!m) return ''            // 认不出就干脆不写，好过写个 cd 进去
```

顺手也修了另一个小毛病：没有用户提示词的回合（比如系统继续推进的回合）原来会记成 `(无提示词)`，现在整段省略，只留工具和文件。

我刻意**没有**让自动捕获去写「决策」和「结论」。因为这需要判断力，而错误判断一旦进记忆，会在后续每个工作区里被当成事实复述——那比没有记忆更糟。这部分留给模型主动 `memory save`，README 里也明说了这条分工：

> 自动捕获记的是「做了啥」，不是「学到啥」。真正的结论请用 `memory save` 显式写——这类判断只有模型自己在场时知道。

## 五、实现：五段值得抄的代码

### 5.1 一个 bundle 插件的骨架

```
package.json          # dsh.bundle.patch 指向 cordis.patch.yml
cordis.patch.yml      # 把本包插进 profile 的 loader 树
lib/index.js          # Host 侧：注入 + 工具 + 捕获
lib/store.js          # 纯逻辑：存储 / 检索 / 渲染（零宿主依赖，可单测）
test/store.test.mjs   # 15 个用例
tools/session-stats.mjs
```

```yaml
# cordis.patch.yml
- insert:
    - id: dsh-memory                       # loader 条目 id —— 故意与包名解耦
      name: dsh-cross-workspace-memory     # 包名
      config: {}
```

```js
// lib/index.js
export const name = 'dsh-memory'
export const inject = ['tools', 'systemPrompt']

export function apply(ctx, config) {
  // …注入、工具注册、事件监听
}
```

### 5.2 坑：`inject` 没声明，服务就是 `undefined`

这条坑值得单开一节，因为它**静默**。

我最初这么写：

```js
const cwd = await ctx.workingDirectory?.ensure?.(exec.agent)   // 看起来万无一失
```

结果 `cwd` 永远是 `''`。原因：`ctx.workingDirectory` 只有在 `export const inject` 里声明过才会被注入，否则是 `undefined`——而可选链 `?.` 把「服务不存在」这个事实，优雅地降级成了「返回 undefined」，然后 `ensure` 那一步也被跳过，最后一路静默到数据库里存了一个空项目名。

**教训：可选链适合「可能为空的值」，不适合「可能不存在的能力」。** 能力缺失应该显式报错或显式兜底，而不是悄悄变成空值。

最终修成四级兜底：

```js
async function cwdOf(agent) {
  try { const d = await wd()?.ensure?.(agent); if (d) return d } catch {}
  const viaHeader = cwdBySession.get(String(agent?.id || ''))   // 从 session.header.cwd 兜底
  if (viaHeader) return viaHeader
  return wd()?.defaultDirectory || ''
}
```

其中 `cwdBySession` 是在 `session/event` 里用 `session.header.cwd` 填的——`SessionHeader` 上就有现成的工作区路径，这比猜 `workingDirectory` 可靠得多。

### 5.3 坑：工具的返回值必须是无损 JSON

宿主在工具返回处有一道门，会递归检查返回值里有没有 `undefined`、`NaN`、`Infinity`、`-0`、`Date`、`Map`、`Set`、类实例、函数、`Symbol`、循环引用。一旦命中：

```
tool "memory" returned invalid output: value is not lossless JSON
```

**整条工具通道被打死**，而且错误信息里不会指出是哪个字段。所以我所有 `execute` 一律只返回 `{ text: '...' }` 这种最朴素的形状，并在写盘前把任何可能为 `undefined` 的字段填成 `null` 或空串。

### 5.4 坑：测试用 `node --test` 会挂在沙箱上

```bash
$ node --test test/store.test.mjs
Error: spawn EPERM
```

原因是 `node:test` 默认通过管道起子进程，而这台机器上 DSH 的文件/进程沙箱不允许。改成直接执行：

```bash
$ node test/store.test.mjs
ℹ pass 15
ℹ fail 0
```

顺带一提，`lib/store.js` 刻意写成**零宿主依赖**——它不 import 任何 `@deepseek-ai/*`。这不是洁癖，而是因为宿主用自定义 loader 解析这些包，纯 node 进程里 `require.resolve('@deepseek-ai/dsh-tools')` 直接 `MODULE_NOT_FOUND`，依赖它就等于把 80% 的逻辑锁在「只能进 DSH 里测」的牢里。

### 5.5 验证注入真的生效：三种方法

| 方法 | 做法 | 能看到什么 |
| --- | --- | --- |
| 自证 | `memory(action:"diagnostics")` | 存储路径、条目统计、当前工作区、本会话 id、**实际注入的索引原文** |
| 外部观察 | 看上下文里的 `<memory>` 块 | 它出现在 `runtime-context` 末尾，顺序在技能目录之后 |
| 反证 | `set_plugin` 停用再启用 | 块消失 / 重新出现，证明它确实由本插件提供 |

第三种方法最硬。我第一次就是靠它确认：「停用后消失、启用后回来」——否则很容易把宿主自带的某段文本误当成自己的输出。

## 六、自验收：两个我自己写出来的 bug

插件第一版「跑起来了」，工具也注册成功了。但我不相信「没报错」这件事，于是起了两个子代理，让它们在**新会话**里、以**另一个工作目录**（`D:\dshproject`）调用这个工具，把回执原样贴回来。

抓到两个 bug，都是真 bug。

**Bug 1：工作区永远是「未解析」。**

```
当前工作区 (未解析)
```

就是上面 5.2 说的 `inject` 没声明。而它之所以能活过我的本地测试，是因为本地测试直接构造 `MemoryStore`，根本不经过 `cwdOf`。**测了逻辑，没测接线。**

**Bug 2：注入文本每轮都在变。**

这是更讽刺的一个：我的插件存在的意义就是「省缓存」，结果它的注入文本每轮都在变，正好踩中自己写下的那条禁令。原因是自动捕获每轮都写一条 `activity`，而 `activity` 又直接进索引。修法就是第三节那条：`skipSession` 过滤掉本会话自己写的进度 + `activity` 每项目封顶 3 条。

还有一个**没有采纳**的反馈值得记：子代理说「诊断里看到的注入文本比实际注入的短/长」。我去读了代码——同一个函数、同一组参数、同一份数据，不可能不一致。这是模型转述时的失真。**二手观测不能当证据，要么看回执原文，要么自己跑一遍。**

## 七、发布这件小事，撞了三个钉子

开发和验证都过了，剩下「发出去」。结果三个钉子。

**钉子一：`desktop` profile 归桌面 app 独占。**

DSH 其实有插件 CLI：

```bash
$ dsh plugin --profile desktop list
error: profile "desktop" is managed exclusively by the Electron application
```

也就是说，桌面版用户装插件只能走 app 内的 `plugin_manager`。它内部就是 `pnpm add <spec>` + 把包名写进 profile 的 `dsh.profile.bundles`，所以「target 就是一个包 spec」——本地目录、tarball、registry 名、git 仓库都行。

**钉子二：包名被占了。**

```bash
$ npm view dsh-memory
0.1.0   maintainer: bbnopromo   2026-08-13
"Durable cross-session memory for DeepSeek Harness: local SQLite FTS5 store,
 three model-facing tools, and a recall prompt section"
```

同名、同用途、比我早两个月。世界就是这么巧——**动手前先 `npm view` 一下**，这条以后我要写进检查清单。

于是改名 `dsh-cross-workspace-memory`，但保留一个技巧：**bundle 的 `id` 不变**。

```yaml
- id: dsh-memory                     # 永不变
  name: dsh-cross-workspace-memory   # 可以改
```

因为有这条，从旧名升级是**原地替换**——配置不用迁、记忆文件不用动，loader 树里也不会留下两条同名条目（换名字那一步我特意先删旧包再装新包，就是为了避免 `memory` 工具被注册两次）。

**钉子三：注册 npm 账号被反机器人拦了。**

```
We detected unusual activity from your device or network.
Automated (bot) activity on your network (IP 39.182.76.135)
```

这是按出口 IP 的判定，运营商共享 IP 很容易中招。结论：**别在发布这条路上死磕**。`npm pack` 打出来的 21KB tarball 自包含、跨机器可装，已经足够分发；哪天有账号了再 `npm publish` 一行的事。

## 八、效果与成本

装好之后，任何一个新工作区的开头都带着上一个项目的上下文——包括**这一篇博客本身是怎么写出来的**（第 4.2 节那段就是从真实回执里抄的）。换成我别的项目，那几条 `[项目] Game`、`[决策] Solar` 会按「本工作区优先」的规则排到前面。

成本方面：

| 项 | 数值 |
| --- | --- |
| 常驻注入 | 实测 626 字符 / 3 条（上限 1600），几百 token 量级 |
| 空库时 | 返回 `''`，**一个 token 都不花** |
| 每轮额外开销 | 0（索引在会话内保持确定，不会触发宿主重发） |
| 检索开销 | 内存内遍历，< 1ms |
| 存储 | 一个 JSON 文件，几十 KB 量级 |
| 依赖 | 0 个 |

最后一行是我最在意的：**没有向量库、没有 sidecar、没有原生模块**。它只是一次 `readFileSync` 和一个 `JSON.parse`。

## 九、如果你也想写一个 DSH 插件：十条清单

1. **先量，再设计。** 会话日志在 `~/.dsh/sessions/`，是多帧 zstd，按魔数切帧。你会看到很多和直觉相反的事实。
2. **注入一律走尾部。** 别改系统提示词、别插在用户消息前——前缀变了，缓存全废。
3. **注入文本必须确定。** 绝对日期、稳定排序、禁止相对时间措辞。否则宿主每轮重发上下文。
4. **本会话自己产生的东西，别进索引。** 这是「每轮都在变」最常见的来源。
5. **`inject` 不声明，服务就是 `undefined`。** 可选链会把这个事实变成静默的空值。
6. **工具返回值必须是无损 JSON。** 只回 `{ text }`，别回 `Date`/`Map`/`undefined`。
7. **`id` 与包名解耦。** 包名会改（撞名、scope 迁移），loader 条目 id 一旦改了就得迁移配置。
8. **把纯逻辑与宿主 API 分开。** `lib/store.js` 零依赖，纯 node 就能单测；接线部分靠真实会话验。
9. **测试用 `node test/x.mjs`，不要 `node --test`**（本机沙箱下 `spawn EPERM`）。
10. **验证要三路对齐：** 工具自述、上下文里看得见的块、停用/启用的反证。只看一路会被自己的乐观骗过去。

## 十、最后

这个插件现在做的事很小：把「上次做到哪、为什么这么定」带到下一个工作区，代价是几百 token 和一个 JSON 文件。

但它纠正了我一个更基础的认知错误。我原本以为问题出在**机器**上——缓存策略、前缀匹配、计费规则。查到底才发现问题出在**经验没有留存**上，而机器那部分早就被设计者照顾好了：会变的东西放在尾部，静态的东西放在前缀。

所以真正的工程动作往往不是「加一个更聪明的机制」，而是「先花两小时把假设证伪，再动手」。这两小时里我做了三个探针、读了两份解压出来的会话正文、写了一个统计脚本——它们没有一行进入最终交付物，却决定了最终交付物长什么样。

---

**代码**：`plugin/` 目录，`lib/index.js`（360 行）+ `lib/store.js`（444 行）+ `test/store.test.mjs`（184 行）+ `tools/session-stats.mjs`（100 行），MIT。
**安装**：`plugin_manager install_bundle target=dsh-cross-workspace-memory`（或直接指向本地目录 / tarball）。
**存储**：`~/.dsh/memory/memory.json`——删了不影响插件，复制走就是全部记忆。
