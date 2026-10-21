# dsh-cross-workspace-memory · 跨工作区长期记忆

> 换一个工作区，不用再从零介绍一遍自己。

`dsh-cross-workspace-memory` 给 DeepSeek Harness 加一层**本机共享**的长期记忆：偏好、事实、项目档案（路径 / 命令 / 约定）、决策理由（选 A 不选 B 及当时的约束）、上次做到哪。所有工作区共用一份存储，条目带项目标签，检索时优先本工作区。

---

## 一、它为什么长这样（先说一件反直觉的事）

这个插件的起点是「换个工作区就丢记忆，缓存命不中，白花钱」。实测之后结论要分开看，而**分开看决定了插件的形状**：

| 现象 | 实测 | 含义 |
| --- | --- | --- |
| system prompt 跨工作区是否相同 | **相同**。里面没有工作区路径；cwd 是靠 `runtime-context` 以历史消息形式注入的，位置在用户首条消息之后 | 缓存前缀本来就是跨工作区可复用的，这部分**没有损失** |
| 换工作区真正丢的是什么 | 对话里攒下的**知识与状态**：这次踩了什么坑、为什么这么定、改到哪了 | 这才是要补的东西 |
| 上下文块什么时候进历史 | 宿主发现上下文文本变了，就把 `runtime-context` **再追加一条**（旧的不删）。实测 16 回合的会话：`time-context` 追加 14 次、`runtime-context` 追加 3 次 | 追加在**尾部**，前面整段的缓存照旧命中；但每追加一次，那段文本就要多付一次 |

由此得到三条设计约束，写死在 `lib/store.js` 与 `lib/index.js` 的注释里：

1. **注入必须放在 prompt 尾部**（`systemPrompt.context`，order 9000，排在 `runtime-context` / `skill-catalog` / `time-context` 之后），绝不碰 system prompt 头部。
2. **注入文本必须确定性**：同一份存储状态渲染出的字节永远相同，只允许绝对短日期（`10-19`），禁止「3 天前」「刚刚」这类会自己漂移的措辞。
3. **注入文本在一次会话里必须基本不动**：所以自动记的进度条目里，**本会话自己刚写的那几条不进索引**（它们就在对话里，对模型零信息量，却会让文本每轮变一次），进度条目在索引里也最多占 3 行。

违反任意一条，插件就会变成它本来要消灭的那种浪费。


---

## 二、三种喂回模型的方式

### 1. 会话开头：注入一份精简索引

一行一条，带类别、项目、日期：

```
<memory 跨工作区记忆 · 3 条 · 本机所有工作区共享>
跨工作区共享的长期笔记；细节用 memory 工具检索（索引只是摘要，别凭它猜细节）。
- [项目] plugin · dsh-cross-workspace-memory 插件：存储在本机 ~/.dsh/memory/memory.json（10-19）
- [决策] plugin · 选择 JSON 文件而非 storageDomain：storageDomain 需要 zod 做值校验（10-19）
- [进度] plugin · 装好插件并在 desktop profile 里验通（10-19）
提示：memory search / save / update / forget / list / diagnostics
```

- 预算默认 1600 字符（约 600 token），超出按类别权重截断 —— `preference` > `decision` > `project` > `fact` > `todo` > `activity`。
- **空库时整块不注入**，一个字都不花。
- 会话中途写入的新记忆**不会**挤进当前会话的索引：本会话自己写的进度条目被排除，其余条目也是在会话开始时就渲染好的——所以要读细节还有工具。

### 2. `memory` 工具：按需检索全文、读写

| 你想干什么 | 参数 |
| --- | --- |
| 回忆「上次做到哪 / 当初为什么这么定」 | `{"query":"打包 为什么 用 electron"}` |
| 记一条 | `{"text":"构建用 pnpm build；打包走 electron-builder --dir 先看结构","kind":"project"}` |
| 改一条 | `{"id":"m3f8a1c07","text":"..."}` |
| 删一条 | `{"action":"forget","id":"m3f8a1c07"}` |
| 看看都有什么 | `{"action":"list","kind":"decision"}` |
| 自检注入是否生效 | `{"action":"diagnostics"}` |

`kind` 支持英文与中文别名：`preference`/偏好、`decision`/决策、`project`/项目、`fact`/事实、`todo`/待办、`activity`/进度。

检索是**中文整句友好**的：英文按词切，中文按二字组，所以「打包为什么慢」能命中「打包用了 electron-builder」这类条目，不需要精确措辞。

### 3. 自动捕获：每轮结束记一条进度

每个 turn 结束写一条 `activity`：「用户这句话的第一句」+「用了哪些工具、各几次」+「碰了哪些文件」。于是新开一个工作区，第一条索引就写着上个工作区做到哪。

- 每个项目只保留最近 3 条（`keepActivities`），不会把索引撑爆。
- 子代理（subagent）会话默认不记，避免噪声。
- 落盘有 1.5 秒合并窗口（同一毫秒内多次写入只落一次）。

自动捕获记的是**「做了啥」**，不是**「学到啥」**。真正的结论（"这个 API 的返回值不是 lossless JSON"，"选了 A 因为 B 在沙箱里起不来"）请用 `memory save` 显式写 —— 这类判断只有模型自己在场时知道。

---

## 三、安装与卸载

三条路，target 就是一个普通的包 spec（内部走 pnpm add + 写 patch）：

```bash
# 1) npm（发布后）
plugin_manager install_bundle  target = dsh-cross-workspace-memory
# 2) tarball（不依赖 registry，适合拷给别人）
plugin_manager install_bundle  target = D:\dshproject\plugin\dsh-cross-workspace-memory-0.1.0.tgz
# 3) 本地目录（开发期推荐：改代码重载即生效）
plugin_manager install_bundle  target = D:\dshproject\plugin
```

> 注意：桌面版的 `desktop` profile 归 Electron app 独占，`dsh plugin --profile desktop add …` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），只能走 `plugin_manager`。

装完重启一次 dsh（或新开一个会话）生效：bundle 会把下面这行插进 profile 的 loader 树（`id` 固定为 `dsh-memory`，改名也不变，方便原地升级）。

```yaml
- insert:
    - id: dsh-memory
      name: dsh-cross-workspace-memory
      config: {}
```

也可以不用 bundle，直接手改 `~/.dsh/profiles/<profile>/cordis.patch.yml` 加同样一行。

卸载：`plugin_manager remove_bundle  target = dsh-cross-workspace-memory`。记忆文件不会被删（在 `~/.dsh/memory/` 下，想清就自己删）。

### 为什么包名叫 `dsh-cross-workspace-memory`

`dsh-memory` 这个名字在 npm 上已被占用（`bbnopromo` 于 2026-08-13 发布了同名包，用途类似：SQLite FTS5 + 三个工具 + recall 段落）。为了不撞名、能发布，本包改用现在的名字；但 **bundle 的 `id` 保持 `dsh-memory` 不变**，所以从旧名升级是原地替换，配置和记忆文件都不用动。

### 打包与分发（维护者）

```bash
npm pack                      # → dsh-cross-workspace-memory-0.1.0.tgz（8 个文件，约 21KB）
# 校验：解包后在 package/ 里跑测试应当 15 pass / 0 fail
tar -xzf dsh-cross-workspace-memory-0.1.0.tgz -C /tmp/x && (cd /tmp/x/package && node test/store.test.mjs)

npm publish                   # 需先 npm login；本包 unscoped，默认 public 访问
```

发布到 GitHub Packages 也行（安装方也需要 token）：

```bash
# 包名改为 @<github账号>/dsh-cross-workspace-memory 后
npm publish --registry=https://npm.pkg.github.com
```

> 若 npm 注册被 "We detected unusual activity" 拦下，那是按出口 IP 判定的反机器人策略（运营商共享 IP 常见）；换手机热点、关掉代理、或等一天再试。不发布也不影响使用 —— 直接分发 .tgz 即可。

---

## 四、配置项

写在 `cordis.patch.yml` 的 `config` 里，全部可省略：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `~/.dsh/memory` | 存储目录（`DSH_HOME` 有值时跟它走） |
| `capture` | `true` | 是否自动记录每轮进度 |
| `maxIndexChars` | `1600` | 会话开头注入的字符上限 |
| `keepActivities` | `3` | 每个项目保留几条进度 |
| `maxItems` | `400` | 总条目上限，超了先删最老的进度条目，再删低权重类别 |

---

## 五、存储格式

单文件 `~/.dsh/memory/memory.json`：

```json
{
  "version": 1,
  "items": [
    {
      "id": "m3f8a1c07",
      "kind": "decision",
      "text": "选择 JSON 文件而非 storageDomain：它需要 zod 做值校验",
      "tags": ["dsh", "storage"],
      "project": "D:/dshproject/plugin",
      "projectName": "plugin",
      "created": 1761000000000,
      "updated": 1761000000000,
      "source": "manual"
    }
  ]
}
```

- 写入是 tmp + rename 的原子替换，不会写坏。
- 文件坏了（JSON 解析失败）不会让插件崩：`loadError` 记下来，工具照常回话。
- 多实例（同时开两个 dsh）各自持有内存副本，落盘前按 `mtime` 变化重读并按 `id` 合并，`updated` 大的胜出；删除不传播 —— 单机单人的场景下，这比加锁便宜得多。

---

## 六、已知边界

1. **索引不是实时的**：本会话里 `memory save` 写进去的东西，要等宿主重新装配上下文才可能出现在索引里（通常要新开一轮/新会话）；当前会话直接用 `memory search` 读，别等索引。同理，本会话自己的进度条目被排除在索引外 —— 这是刻意的（见第一节约束 3）。
2. **只记本机会话**：不跨机器同步。想同步就把 `memory.json` 放进自己的同步盘，并把 `dir` 指过去。
3. **中文检索按二字组**：够用但不是分词，太短的查询（一个字）会命中偏多。
4. **索引是摘要**：故意只放一行一条。凭索引猜细节是这类插件最常见的误用 —— 工具描述里已经写明「索引只是摘要，要细节就 search」。
5. **改完代码要重载**：`plugin_manager set_plugin target="include:dsh-memory" enabled=false` 再 `true`（只改 `lib/*.js` 的话，热重载不会自己发生；ESM 模块有缓存）。

---

## 七、开发

```bash
node test/store.test.mjs      # 15 个用例，约 100ms
```

> 别用 `node --test`：本机沙箱下 `node:test` 默认走 pipe 子进程，会 `spawn EPERM`。

- `lib/store.js` —— 纯逻辑，零宿主依赖（可脱离 DSH 单测）。
- `lib/index.js` —— Host 侧：注入 + 工具 + 自动捕获。`@deepseek-ai/dsh-tools` 只能由 DSH Host 进程解析，纯 node 进程 import 不了，所以测试只覆盖 store。
- `tools/session-stats.mjs` —— 解压 `~/.dsh/sessions/` 下的多帧 zstd 日志，统计各会话的回合数与上下文追加次数（本文第一节那些实测数据就是它跑出来的）。

---

## 八、延伸阅读

- [给 DeepSeek Harness 做一层跨工作区记忆](./docs/blog-cross-workspace-memory.md) —— 完整的过程记录：怎么用会话日志证伪「换工作区就丢缓存」、注入位置为什么决定生死、6 个踩过的坑、以及发布时撞的三个钉子。
