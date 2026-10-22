# dsh-cross-workspace-memory

[![CI](https://github.com/Urtaome0211/dsh-cross-workspace-memory/actions/workflows/ci.yml/badge.svg)](https://github.com/Urtaome0211/dsh-cross-workspace-memory/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-cross-workspace-memory.svg)](https://www.npmjs.com/package/dsh-cross-workspace-memory)
[![npm downloads](https://img.shields.io/npm/dm/dsh-cross-workspace-memory.svg)](https://www.npmjs.com/package/dsh-cross-workspace-memory)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522.19-brightgreen.svg)](./package.json)
[![deps](https://img.shields.io/badge/dependencies-0-success.svg)](./package.json)

**English** · [简体中文](./README.zh-CN.md)

> Switching workspaces shouldn't mean introducing yourself all over again.

`dsh-cross-workspace-memory` adds a **machine-local, shared** long-term memory layer to
DeepSeek Harness: preferences, facts, project profiles (paths / commands / conventions), decision
rationale (why A over B, under what constraint), and where you left off. Every workspace reads and
writes the same store; entries carry a project tag, and retrieval ranks the current workspace first.

---

## 1. Why it looks like this (one counter-intuitive fact first)

The starting point was a hunch: *"new workspace → memory lost → cache misses → wasted tokens."*
Measurement splits that into two claims, and **the split is what shaped the plugin**:

| Question | Measured | Consequence |
| --- | --- | --- |
| Is the system prompt different across workspaces? | **No.** It contains no workspace path; the cwd arrives later as a `runtime-context` history message, after the first user message | The cached prefix is already reusable across workspaces — **nothing lost there** |
| Then what *is* lost when you switch? | The **knowledge and state** built up in the conversation: what broke, why it was decided that way, how far you got | That is the gap worth filling |
| When do context blocks enter history? | When the host sees the context text change, it **appends another** `runtime-context` message (nothing is deleted). In a 16-turn session: `time-context` appended 14×, `runtime-context` 3× | Appending happens at the **tail**, so prefix caching still hits — but each re-append re-pays for that text |

Three design constraints follow, and they are written into the comments of `lib/store.js` and
`lib/index.js`:

1. **Injection lives at the prompt tail** (`systemPrompt.context`, order 9000 — after
   `runtime-context` / `skill-catalog` / `time-context`). It never touches the system prompt head.
2. **Injected text must be deterministic**: the same store state must render to the same bytes.
   Only absolute short dates (`10-19`); never "3 days ago" or "just now", which drift on their own.
3. **Injected text must stay stable within a session**: so progress entries *written by the current
   session* are excluded from the index (they are already in the transcript — zero information, but
   they would change the text every turn), and progress entries take at most 3 lines of the index.

Break any one of the three and the plugin becomes the very waste it exists to remove.

---

## 2. Three ways memory reaches the model

### 2.1 Session start: a compact index is injected

One line per entry, with kind, project and date:

```
<memory 跨工作区记忆 · 3 条 · 本机所有工作区共享>
跨工作区共享的长期笔记；细节用 memory 工具检索（索引只是摘要，别凭它猜细节）。
- [项目] plugin · dsh-cross-workspace-memory 插件：存储在本机 ~/.dsh/memory/memory.json（10-19）
- [决策] plugin · 选择 JSON 文件而非 storageDomain：storageDomain 需要 zod 做值校验（10-19）
- [进度] plugin · 装好插件并在 desktop profile 里验通（10-19）
提示：memory search / save / update / forget / list / diagnostics
```

- Budget: 1600 characters (~600 tokens) by default; overflow is truncated by kind weight —
  `preference` > `decision` > `project` > `fact` > `todo` > `activity`.
- **An empty store injects nothing at all** — zero tokens.
- Anything written *during* a session does not squeeze into the current index (see constraint 3).
  That is what the tool is for.

<sub>The wrapper lines of the index are currently in Chinese; the entry lines in between are
whatever you saved, verbatim.</sub>

### 2.2 The `memory` tool: on-demand read/write

| Goal | Arguments |
| --- | --- |
| Recall "where did I leave off / why was it decided this way" | `{"query": "build why electron-builder"}` |
| Save a note | `{"text": "Build with pnpm build; packaging goes through electron-builder --dir first", "kind": "project"}` |
| Edit a note | `{"id": "m3f8a1c07", "text": "..."}` |
| Forget a note | `{"action": "forget", "id": "m3f8a1c07"}` |
| Browse | `{"action": "list", "kind": "decision"}` |
| Check that injection actually works | `{"action": "diagnostics"}` |

`kind` also accepts Chinese aliases (偏好 / 决策 / 项目 / 事实 / 待办 / 进度).

Search is **friendly to whole Chinese sentences**: English is split on words, Chinese on
two-character bigrams, so "打包为什么慢" hits an entry like "打包用了 electron-builder" without
needing the exact wording.

### 2.3 Auto-capture: one progress note per turn

At the end of each turn an `activity` entry is written: *the first sentence of the user's request*
+ *which tools ran, how many times* + *which files were touched*. Open a new workspace and the
first index line already says where the last one stopped.

- Only the latest 3 per project (`keepActivities`), so the index stays small.
- Subagent sessions are skipped by default (noise).
- Writes are debounced by 1.5 s (several writes in the same window land once).

Auto-capture records **what was done**, not **what was learned**. Real conclusions ("this API's
return value is not lossless JSON", "chose A because B won't start inside the sandbox") must be
written explicitly with `memory save` — only the model on the spot knows them.

---

## 3. Install

```bash
plugin_manager install_bundle  target = dsh-cross-workspace-memory
```

That fetches the package from npm. Open a new session and the index shows up at the top.

### Why the package is named `dsh-cross-workspace-memory`

The name `dsh-memory` was already taken on npm (`bbnopromo` published a package under it on
2026-08-13 with a similar purpose: SQLite FTS5 + three tools + a recall section). To be able to
publish at all, this package uses the current name — but **the bundle `id` stays `dsh-memory`**, so
upgrading from the old name replaces it in place; config and memory files are untouched.

### Packaging and distribution (maintainers)

```bash
node test/store.test.mjs      # 17 pass / 0 fail
npm pack                      # → dsh-cross-workspace-memory-<version>.tgz
# verify: unpack and run the tests inside package/ to prove the tarball is self-contained
tar -xzf dsh-cross-workspace-memory-0.1.2.tgz -C /tmp/x && (cd /tmp/x/package && node test/store.test.mjs)

npm publish --dry-run         # inspect the file list first
npm publish                   # unscoped package → public on the default registry
npm view dsh-cross-workspace-memory version dist.tarball   # verify after publishing
```

> **A brand-new package name first shows up as a placeholder version.** The registry creates
> `0.0.0-stage` (packument `stub: true`, README "Temporary package placeholder for staged
> publishing"), the real version goes into review, and `latest` is repointed automatically when it
> passes. In this project the gap between `npm publish` and `npm view … version` returning `0.1.0`
> was about 3 minutes, during which only `0.0.0-stage` was visible — do not treat that as a failure
> and do not bump the version and re-publish. If it sits on the placeholder for a long time, check
> `npm stage list` for a pending staged release (`npm stage view / approve / reject <id>`).

Release order: bump `version` in `package.json` → update the numbers here and any CHANGELOG → test
→ `npm publish` → `git tag vX.Y.Z && git push --tags`. The README ships with the package, so **edit
the README before publishing**; npm never lets you overwrite a published version, so a wording fix
means another patch release.

> **2FA kills publishing from a non-interactive terminal.** With `auth-and-writes` enabled,
> `npm publish` needs one interactive step: in a real terminal it prints an auth URL or asks for a
> 6-digit code; in CI/pipes it fails with `EOTP`, and the URL is masked to `***` (anti-leak), so you
> cannot even copy it out. Two workable routes: `npm publish --otp=<code>`, or a **granular token
> with "Bypass 2FA" checked** (note: classic tokens can no longer be created since 2025-11 and
> existing ones were revoked; bypass-enabled granular tokens still publish directly for now, and npm
> plans to retire that in 2027-01 — after that, use trusted publishing / staged publishing).

GitHub Packages works as a mirror (installing from it also needs a token):

```bash
# the package name must become @<github-user>/dsh-cross-workspace-memory
npm publish --registry=https://npm.pkg.github.com
```

---

## 4. Configuration

Set in the `config` of `cordis.patch.yml`; every key is optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `dir` | `~/.dsh/memory` | Store directory (follows `DSH_HOME` when set) |
| `capture` | `true` | Auto-capture one progress note per turn |
| `maxIndexChars` | `1600` | Character budget of the injected index |
| `keepActivities` | `3` | Progress notes kept per project |
| `maxItems` | `400` | Hard cap; oldest progress notes are dropped first, then low-weight kinds |

---

## 5. Storage format

A single file, `~/.dsh/memory/memory.json`:

```json
{
  "version": 1,
  "items": [
    {
      "id": "m3f8a1c07",
      "kind": "decision",
      "text": "Chose a JSON file over storageDomain: it requires zod for value validation",
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

- Writes are atomic (tmp + rename), so a crash cannot corrupt the file.
- A broken file (JSON parse failure) never crashes the plugin: `loadError` is recorded and the tools
  keep answering.
- Multiple instances (two dsh windows) each hold an in-memory copy; before writing, a copy re-reads
  the file, and if the **content** changed it merges by `id` with the newer `updated` winning.
  Deletions do not propagate — on a single-user machine that is far cheaper than locking. Content is
  compared deliberately instead of mtime: timestamp resolution can be too coarse for two consecutive
  writes to differ (this actually happened on Windows CI).

---

## 6. Known limits

1. **The index is not live.** An entry saved with `memory save` during a session only appears in the
   index once the host reassembles context (usually a new turn/session). Read it with `memory search`
   now instead of waiting. Progress notes from the current session are excluded on purpose (see
   constraint 3 in §1).
2. **Local machine only.** No cross-machine sync. Put `memory.json` on your own synced folder and
   point `dir` at it if you want that.
3. **Chinese search uses bigrams.** Good enough, but not real segmentation; one-character queries
   will over-match.
4. **The index is a summary.** Guessing details from it is the most common misuse of this kind of
   plugin — the tool description itself says "the index is a summary, search for details".
5. **Reload after code changes.** `plugin_manager set_plugin target="include:dsh-memory"
   enabled=false` then `true` (editing `lib/*.js` does not hot-reload — ESM caches modules).

---

## 7. Development

```bash
node test/store.test.mjs      # 17 cases, ~100 ms
```

> Do not use `node --test` here: under the local sandbox `node:test` spawns piped child processes
> and fails with `spawn EPERM`.

- `lib/store.js` — pure logic, zero host dependencies (unit-testable outside DSH).
- `lib/index.js` — host side: injection + tool + auto-capture. `@deepseek-ai/dsh-tools` is resolved
  by the DSH host process only, so tests cover `store` alone.
- `tools/session-stats.mjs` — decompresses the multi-frame zstd session logs under `~/.dsh/sessions/`
  and counts turns plus context re-appends (the numbers in §1 come from it).

---

## 8. Further reading

- [Building a cross-workspace memory layer for DeepSeek Harness](./docs/blog-cross-workspace-memory.md)
  — the full story: falsifying "a new workspace loses the cache" with session logs, why the
  injection point decides everything, six pitfalls, and three nails hit while publishing. *(Chinese.)*

---

## 9. License

[MIT](./LICENSE) © 2026 Urtaome0211

The reasoning is practical: this is a zero-dependency tool a few dozen kilobytes in size, and MIT is
the most common, least demanding choice in the DSH plugin ecosystem — commercial use, forks and even
closed-source redistribution are fine as long as the notice stays; it also stays compatible if
someone folds it into a GPL project. No need to ask before using it.

## 10. Contributing

Issues and PRs are welcome. Two hard constraints are not style preferences — they are the root of
the design:

1. **Never move the injection into the system prompt or ahead of user messages** — change the prefix
   and the whole prompt cache is void, which removes the reason this plugin exists.
2. **Injected text must be byte-for-byte deterministic** (absolute dates, stable ordering, excluding
   what the current session just wrote). Unit tests guard this: `test/store.test.mjs` has "renders
   identically twice" and "contains no relative-time wording"; they will complain first when you
   touch `renderIndex`.
