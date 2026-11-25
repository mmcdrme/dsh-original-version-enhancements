# 永久删除报告成功之后，会话字节还可能在哪里

> 议题：GitHub issue #15（label `wayfinder:research`）。
> 审计对象：本仓库 commit `2fa7903`（worktree 分支 `research/permanent-delete-residue`）。
> 一手来源：
> - 产品代码：本仓库 `host/delete-session.mjs`、`host/deleted-sessions.mjs`、`host/transfer.mjs`、`host/architecture` 侧 `index.js`、`client.js`、`test/*.test.mjs`。
> - DSH 核心：打包内的 `resources/app.asar/dsh/node_modules/@deepseek-ai/{dsh-session-persistence-jsonl,dsh-workspace,dsh-session-projection-cache}/lib/index.js`（本机 @deepseek-ai/dsh-desktop-runtime@0.2.2-rc.5）。
> - 本机实测：`~/.dsh`（Windows，profiles = bili-duty / desktop / headless / web）。
> 标注约定：**事实**=有 file:line 或实测支撑；**未确认**=没找到一手证据，不猜。

---

## 0. 结论摘要（每条一句话）

1. `purgeRetainedSession` 先写索引再 `rm`，`rm` 失败只 warn（`host/deleted-sessions.mjs:421-425`）——回收区里会留下"索引不再认识"的字节目录。
2. 这类孤儿目录只在插件启动时按 mtime（默认 >1 小时）清（`host/deleted-sessions.mjs:462-474` + `index.js:448-452`），应用一直开着就一直留着。
3. 反方向同样成立：索引写失败被 `.catch(() => undefined)` 吞掉（`host/deleted-sessions.mjs:422`），目录已删、索引还挂着一条指向空气的 entry。
4. 空壳目录（有目录、没有 `session*.jsonl(.zstd)`）由本插件按"raw id"扫描所有 project 目录兜底删除（`host/delete-session.mjs:222-264`）；而 DSH 盘上的目录名是 `encodeSegment(id)`（`dsh-session-persistence-jsonl/lib/index.js:858-870,919-921`），含非常规字符的 id 会扫不到。
5. `mkdtemp` 隔离目录建在 `dirname(sessionRoot)`（即 `~/.dsh`），三个前缀由本插件按 mtime>1h 清（`host/delete-session.mjs:944,960-1009`）；DSH 自己的 `.dsh-mkdir-*` 暂存目录不在白名单里（`dsh-session-persistence-jsonl/lib/index.js:604`）。
6. 单删 / 批量删（归档页）/ 隐藏会话清理三条人类路径**共用**同一个 `/sessions/delete` → `deleteSessionSafely` → retain/purge/accounting（`client.js:1451-1463,3338,3474`；`index.js:307-346`）。
7. 回滚路径**刻意不共用**：复制/移动失败走 `deleteSessionWithoutReservation(..., { purge: false })`，不碰 DSH 账目（`host/transfer.mjs:507-518`；`host/delete-session.mjs:419-426`）；移动成功则手写一份 source accounting 清理（`host/transfer.mjs:471-481`）。
8. DSH 只有一个会话根 `<DSH_HOME>/sessions`，所有 profile 共用；会话目录唯一由 `projectKey(cwd)` 决定，同一 id 出现在两个 project 目录会让 `list()` 直接抛错（`dsh-session-persistence-jsonl/lib/index.js:3136`），即"整个 profile 看不到任何会话"。
9. 回收区/索引是按 profile 分目录的（`host/automation.mjs:41-44` + `host/deleted-sessions.mjs:22,30`），而会话、`workspace.json`、`session_projcache` 在 DSH_HOME 全局——A profile 删掉的会话，B profile 的索引完全不知情。
10. 账目与文件的两个反向都由 fail-soft 逻辑造成：删除成功但 `purgeSessionAccounting` 内部全部吞错（`host/delete-session.mjs:795-814`）→ 账目留 id；undo 的 `indexHeader/attach/coldSnapshot` 失败只回 warning（`host/deleted-sessions.mjs:342-382`）→ 文件回位但列表看不见。

---

## 1. 回收区 `<profileDir>/deleted-sessions/<token>` 与索引 `original-version-enhancements.deleted.json` 不一致的窗口

### 事实

- 路径定义：`retainedRoot = <profileDir>/deleted-sessions`（`host/deleted-sessions.mjs:22`）、`retainedStateFile = <profileDir>/original-version-enhancements.deleted.json`（`host/deleted-sessions.mjs:30`）。
- retain 的顺序是 **先移动目录、再写索引**（`host/deleted-sessions.mjs:232-263`）：`moveDirectory(sourceDirectory, directory)`（:233）→ 组装 entry → `writeRetainedState`（:247）。写失败会尝试移回（:250-251），移回也失败则打 `error.retained = 'orphaned'` + `trashDirectory`（:252-259）；删除端把这条错误翻成 `storage-partial` 并把真实位置写进提示（`host/delete-session.mjs:722-738`）。
- purge 的顺序是 **先删索引、后 rm**（`host/deleted-sessions.mjs:416-427`）：
  - `delete state.entries[token]`（:421）
  - `await writeRetainedState(...).catch(() => undefined)`（:422）——写失败被吞
  - `await rm(entry.directory, { recursive: true, force: true }).catch(warn)`（:423-425）——rm 失败只 warn
- 未登记目录的清理只在两个条件下发生：启动时 `purgeStaleRetainedSessions`（`index.js:448-452`），且目录 mtime 老于 `maxAgeMs`（默认 1 小时，`host/deleted-sessions.mjs:15,469`）。索引条目过期则按 `entry.createdAt`（:452）。

### 三个具体窗口

| 窗口 | 怎么发生 | 磁盘上剩下什么 |
|---|---|---|
| A 索引删了、目录删不掉 | :421-422 成功，:423-425 的 `rm` 抛错（Windows 上文件被 AV/索引器/资源管理器持有 → `EBUSY/EPERM`；或只读属性） | `<profileDir>/deleted-sessions/<token>/session.v4.jsonl.zstd` 完整字节，索引里没有它的 token |
| B 索引写失败、目录已删 | :422 被吞，:423 `rm` 成功 | 索引里留着一条 entry，`entry.directory` 已不存在 |
| C retain 中途崩 | :233 移动完成、:247 写索引前进程死 | 回收区里有目录、索引里没有 entry，且没有任何 receipt 能 undo |

### 触发条件

- 窗口 A：purge 的触发源有三处，都是"正常路径"——客户端 10 秒倒计时（`client.js:6948-6952`）、用户点 × 关闭 receipt（`client.js:7017-7025`）、超过 3 条 receipt 时挤掉最老的一条（`client.js:1109-1120`）。任何一次 `rm` 失败都会落到窗口 A。
- 窗口 B：索引文件被占用/权限问题（`writeRetainedState` 有唯一 tmp 名 + 一次重试，:93-121，仍可能失败）。
- 窗口 C：进程崩溃/断电，或 `purgeStaleRetainedSessions` 恰好并发（它被同一 `serializeState` 队列保护，:232,438，所以是崩溃而非竞争）。

### 可观测信号

- 目录侧：`<profileDir>/deleted-sessions/` 下的子目录名不在 `original-version-enhancements.deleted.json` 的 `entries` 键里。
- 日志侧：`deleted-sessions: could not remove <dir>: <error>`（`host/deleted-sessions.mjs:424`）。
- 反向（窗口 B）：`entries[token].directory` 指向的路径不存在；之后 undo 一定回答 `undo-expired`（`host/deleted-sessions.mjs:327-333` 的 ENOENT 分支）。
- 本机实测：`~/.dsh/profiles/desktop/deleted-sessions/` 存在但为空，索引是 26 字节的 `{"version":1,"entries":{}}`——**"回收区目录在、索引空"本身是正常状态**，不能拿来判定残留。

---

## 2. 空壳 `<sessionRoot>/<project>/<sessionId>` 与 `.dsh-session-delete-*` / `mkdtemp` 隔离目录

### 事实

- 空壳判定：目录里没有任何 `session(.vN).jsonl(.zstd)` 才算空壳（`host/delete-session.mjs:261`）；这类目录会被当成 phantom 删除，走同一套"先改名隔离、复核 inode、再删"的协议（`host/delete-session.mjs:301-346`）。
- phantom 扫描用 **raw id** 拼 `join(root, project.name, sessionId)`（`host/delete-session.mjs:246`）；DSH 盘上的目录名是 `encodeSegment(id)`：安全码位原样、其余 `~XXXX`（`dsh-session-persistence-jsonl/lib/index.js:858-870`），拼进 `sessionDir(root, cwd, id)`（:919-921）。正常 id（uuid / `session-<uuid>`，实测两种都有）两者相同；含 `~` 或非安全码位的 id 会不匹配。
- 删除/移动/回滚共三个隔离前缀：`.dsh-session-delete-`（`host/delete-session.mjs:307` phantom、:660 正常）、`.dsh-session-move-`（:869）、`.ove-transfer-rollback-`（`host/transfer.mjs:557`）；白名单 `QUARANTINE_PREFIXES`（`host/delete-session.mjs:944`）恰好就是这三个。
- 隔离目录建在 `dirname(validated.root)`，即 `~/.dsh` 下（`host/delete-session.mjs:307,660,869`）；sweep 现在扫三处：`sessionRoot`、`dirname(sessionRoot)`、以及 root 下每个 project 目录（`host/delete-session.mjs:992-1007`），默认只删 mtime 老于 1 小时的（:961,977）。
- 正常删除成功后，隔离根用 `rm(quarantineRoot, { recursive: true, force: true })` 收尾，且失败被吞（`host/delete-session.mjs:326,339,342`）——空的 `.dsh-session-delete-xxxx` 会留下，直到下次启动 sweep。
- DSH 侧的额外事实：Windows 的 mkdir 走 `mkdtemp(join(parent, ".dsh-mkdir-"))` 暂存再发布（`dsh-session-persistence-jsonl/lib/index.js:603-615`），这个前缀**不在**本插件白名单里，崩在 `publishNewFileWin32` 之前就会永久留下一个空的 `.dsh-mkdir-*`。
- POSIX 上 DSH 会在会话目录里留 `session.lock` 且明确"release 从不删锁文件"（`dsh-session-persistence-jsonl/lib/index.js:648,719-723`）；Windows 用命名内核信号量、没有锁文件（:678-690）。所以"只有 session.lock 的目录"是 POSIX 特有形态——本插件会把它当空壳删掉（:261 只认 jsonl），这既清掉了残留，也意味着 POSIX 上会话目录不会自己消失。

### 触发条件

- 空壳：materialize 在 `mkdir` 之后、首个 append 之前被打断（DSH 注释：未 materialize 的会话没有文件系统足迹，`dsh-session-persistence-jsonl/lib/index.js:637-640`，所以只有中断才会留壳）；或者用户/脚本手工删掉 `session.v4.jsonl.zstd` 而留下目录（`host/delete-session.test.mjs:443-462` 锁定了这个场景）。
- 隔离目录残留：删除/移动/回滚在 rename 之后、rm 之前崩溃；或 rm 本身失败（`force: true` 也会因 `EBUSY/EPERM` 失败）。
- `.dsh-mkdir-*`：DSH 建目录时崩溃（Windows 专属）。

### 可观测信号

- `<sessionRoot>/<project>/<id>/` 存在但没有 `session*.jsonl(.zstd)`；或只剩 `session.lock`（POSIX）。
- `~/.dsh/.dsh-session-delete-*`、`~/.dsh/.dsh-session-move-*`、`~/.dsh/.ove-transfer-rollback-*`（mtime 老于 1 小时的最可疑）。
- `<project>/.dsh-mkdir-*`（空目录；DSH 崩溃残留，本插件不会清）。
- 日志：`original-version-enhancements: could not sweep <target>: <error>`（`host/delete-session.mjs:981`）。

---

## 3. 隐藏会话清理 / 批量删除 / 移动复制回滚是否共用同一套 retain/purge

### 事实

- 三条人类删除路径都调用同一个 client 函数 `requestDelete`（`client.js:1451-1485`），都带 `retain: true`：
  - 单条右键删除：`client.js:7116`（`publishDelete` 后由对话框提交）。
  - 归档页批量删除：`deleteMany`，`client.js:3326-3364`（每条 `requestDelete(..., false, true)`，失败再用 `force` 重试）。
  - 隐藏会话清理：`clearHidden`，`client.js:3464-3500`（同样的循环 + 一个合并 receipt）。
- 服务端只有一条路由 `POST /plugins/original-version-enhancements/sessions/delete` → `deleteSessionSafely`，retain 才注入 `retainDeletedSession`（`index.js:307-346`）。
- 差别只在 receipt 记账：批量把多个 token 塞进一个 notice（`client.js:3332-3357`），多于 3 个 receipt 时最老那条的 token 会被 `requestPurge`（`client.js:1109-1120`）——第四条删除会在 10 秒窗口内被"提前永久化"。
- 移动成功：`quarantineSessionForMove`（`.dsh-session-move-`）→ 在目标处重建 → **手写**清 source accounting（`host/transfer.mjs:471-481`），不走 `purgeSessionAccounting`。
- 移动失败回滚：`quarantine.restore()`（`host/transfer.mjs:449-456`）+ `reindexMovedSession`（:465），不碰账目。
- 复制：新 id `session-${randomUUID()}`（`host/transfer.mjs:323`）；失败回滚 `removeCopyWhileReserved` → `deleteSessionWithoutReservation(..., { force: true, purge: false })`（`host/transfer.mjs:507-518`），再兜底 `removeUnindexedMaterialization`（:529-575，`.ove-transfer-rollback-` 隔离）。
- `deleteSessionWithoutReservation` 的注释直接写了原因：回滚删的是"从未入账"的副本，清账目会把 source workspace 解绑（`host/delete-session.mjs:419-426`）。

### 触发条件 / 残余风险

- 共用链意味着：**任何一次删除失败的新形态都会同时出现在三条 UI 路径里**（没有哪条有独立兜底）。
- 不共用链意味着：移动成功的清账逻辑是第 4 份实现（另有 `purgeSessionAccounting`、启动 reconcile、transfer 手写版），字段集合已经不同（手写版清 detach/unarchive/unpin，但不清 projcache 记录）→ 移动后 projcache 里可能留着旧 workspace 的标题/projection 直到下一次写入（**未确认**：projcache 是否会在 header 变更后自行失效，见 §9）。

### 可观测信号

- 移动后 `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 workspace/cwd 字段是否立刻更新——未实测。
- 复制失败但目录残留：`<root>/<project>/session-<newUuid>/` 存在且 DSH `list()` 里没有它（后端还没索引）。

---

## 4. 多 profile / 多工作区：DSH 会不会把同一 sessionId 放到别处

### 事实

- 会话根来自 `resolve(config.root)`（`dsh-session-persistence-jsonl/lib/index.js:2434`）；本机实测只有一个 `~/.dsh/sessions`，里面 8 个 project 目录，cwd 横跨默认工作区、CLI 仓库、临时测试目录、以及 `~/.dsh/profiles/desktop` 本身。
- 会话目录 = `<root>/<projectKey(cwd)>/encodeSegment(id)`（`dsh-session-persistence-jsonl/lib/index.js:907-910,919-921`）；`cwd` 缺失时落在 `_no-cwd`（:908）。`projectKey` 有损：分隔符折叠成 `-`、非安全码位 `~XXXX`、截断到 251 字符（:880-899）——两个不同 cwd 可能映射到同一个 project 目录。
- `list()` 对同一 id 出现在多个 project 目录是**硬错误**：`throw new Error("duplicate JSONL session id ... appears in multiple project directories")`（`dsh-session-persistence-jsonl/lib/index.js:3136`）。后果不是"多一条重复"，而是整个 `list()` 失败。
- materialize 只按 `header.cwd` 决定位置（:3204-3206），所以"同一 id 换个 workspace"不会自动迁移，必须显式移动（本插件的 move 复用 id，copy 用新 id，`host/transfer.mjs:323`）。
- 回收区/索引按 profile 分（`host/automation.mjs:41-44`：`DSH_PROFILE_DIR` 或 `~/.dsh/profiles/<DSH_PROFILE>`；`host/deleted-sessions.mjs:22,30`），而 `workspace.json` 与 `session_projcache` 在 `~/.dsh/storages/`（实测），是全局的。

### 结论

- DSH 不会主动把同一 id 放到别处；唯一会让同一 id 换目录的是"移动"（本插件）或用户手工搬目录。
- 真正危险的是**重复 id**：手工/外部工具把目录复制到另一个 project 下会让 `list()` 抛错，整个 profile 变空。本插件的 `removePhantomSessionDirectories`（`host/delete-session.mjs:267-290`，扫全部 project 目录、最多 8 轮）正是为"删了又回来"这类历史 bug 加的兜底。
- profile 之间错位：在 headless profile 里删掉一个 desktop 也在用的会话，字节被移进 `~/.dsh/profiles/headless/deleted-sessions/`，desktop 的 receipt/索引完全不知道（不能 undo，也不会扫到它）。

---

## 5. 反向：账目（workspace registry / projection cache）与文件的两个方向

### 事实

- 删除成功才清账目：`if (result.ok) await purgeSessionAccounting(deps, sessionId)`（`host/delete-session.mjs:406`）。
- `purgeSessionAccounting` 全 fail-soft：`detachSession` 逐 workspace 吞错（:799-803）、`unarchiveSession`（:805）、`unpinSession`（:806-808）、projcache `table.delete`（:810-813）——任何一步抛错都只当"下次启动 reconcile"。
- projcache 的落点：domain `session_projcache`、table `sessions`、`layout: 'per-record'`、`invalidRecords: 'backup-and-skip'`（`dsh-session-projection-cache/lib/index.js:89-100`）；源码注释写明 shipped json backend 一条记录一个文档，落在 `<root>/session_projcache/sessions/`（:9-15）。实测：`~/.dsh/storages/session_projcache/sessions/`。
- workspace 账目：`archivedSessionIds` / `pinnedSessionIds` / `workspaces.sessionIds` 三处（`dsh-workspace/lib/index.js:229-267`），实测落在 `~/.dsh/storages/workspace.json`。
- 启动 reconcile（`index.js:224-305`）的闸门：
  - `persistence.list()` 抛错 → 直接 return（:230-236）；
  - `known.size === 0` → 直接 return（:242，"空列表 = 根不可读"，注释说明这会曾把整个 profile 的账目清空）；
  - `onDisk`（root 下 depth<=3 的所有目录名）含该 id → **不删**（:263-267,297）；
  - 只处理 archived 集合 + 持久表里的 id（:268-291），不对 registry 里没有的"孤儿"做任何添加。
- "文件在、DSH 看不见"的几条来源：
  - undo 的 `indexHeader` / `resolveByPath` / `attachSession` / `archive` / `pin` / `coldSnapshot` 失败一律只回 `warning`（`host/deleted-sessions.mjs:342-382`），文件已回位但不进列表。
  - header 损坏/版本超前：DSH `list()` 对单条 artifact 的解析失败是 `return { metadata: void 0 }`（`dsh-session-persistence-jsonl/lib/index.js:3123-3127`），会话被跳过；本插件的删除仍能删（`host/delete-session.mjs:554-570` 历史/损坏分支）。
  - 重复 id：`list()` 整体抛错（:3136）。
- "账目在、文件不在"的几条来源：
  - `purgeSessionAccounting` 内部吞错（上面）；
  - 手工/外部删掉会话目录后，要等下次启动 reconcile；而 reconcile 遇到 `list()` 抛错或空列表就整体放弃；
  - `onDisk` 只看目录名：一个只剩空壳的 `<project>/<id>/` 会**保住**该 id 的账目（设计如此），直到有人删掉这个空壳（本插件的 phantom 分支，`host/delete-session.mjs:490-513,626-633`）。

### 可观测信号

- 账目有 id、文件不在：`workspace.json` / projcache 里出现 `list()` 里没有的 id；UI 上是"点了打不开的幽灵会话"；`index.js:263-300` 的 reconcile 只在启动时修。
- 文件在、账目看不见：目录与 `session*.jsonl(.zstd)` 都在，但侧边栏没有；重启后是否恢复 = DSH 启动时是否重扫 header（**未确认**，见 §9）。
- 本机实测：95 个 session 目录 vs 95 条 projcache 记录，集合相等，当前无幽灵——说明 reconcile 在这台机器上是收敛的，但这是"启动后某一刻"的快照，不是保证。

---

## 6. 测试里已经锁定了什么，什么没覆盖

### 已锁定

`test/delete-session.test.mjs`：
- 正常删除（含 stop+detach）：:132-152
- retain 交接（目录真的被移进 trash，未删）：:154-185
- retain 失败 → `storage-partial`，绝不报成功：:187-220
- 空壳可删（phantom 标记）：:406-421
- 一个 id 的**所有**空壳都要删（两个 project 目录）：:423-441
- header 在、日志没了也能删：:443-462
- 删除后清账目（detach/unarchive/unpin + table.delete）：:486-515
- 被拒绝的删除**不动**账目：:517-543
- 启动 sweep：隔离目录在 root 的**兄弟**位置也要被扫到、只删 >1h、未相关目录不动：:567-598

`test/deleted-sessions.test.mjs`：
- retain 移动 + 索引身份：:47-66
- undo 全链路（含 archived 还原、projcache 冷写、token 一次性）：:68-119
- undo 与 purge 竞争同一 token 串行化：:121-158
- purge 真删字节：:160-181
- 索引写失败 → 目录移回 + 不留未登记目录：:183-203
- 缺字段的 entry 被丢弃而不是抛 TypeError：:206-227
- undo 取预约、还原 pin：:229-291
- 过期条目按 `createdAt` 清、新的保留：:293-322
- 8 个并发 retain 都进索引、不留 `.tmp`：:324-368

`test/r5-regression.test.mjs`：R1 retain 回滚（:55-79）、R2 `orphaned` → 删除不报 ok（:85-104）。
`test/reported-bugs.test.mjs`：H2 隐藏会话清理必须先确认（:56-66）。
`test/transfer.test.mjs`：move 保 id（:164）、失败 move 还原原目录（:217）、开着的 turn 还原（:242）、archived 拒绝（:270）、copy 新 id（:293）、copy/move 失败删掉半成品（:373,399,428）、预约（:448,478）。

### 没有覆盖（grep 全 test 目录：无 `deleteSessionWithoutReservation`、`_no-cwd`、`duplicate`、`dsh-mkdir`）

1. **purge 的 `rm` 失败**（§1 窗口 A）——没有测试构造 `rm` 抛错。
2. **purge 的索引写失败**（窗口 B）——没有测试。
3. **retain 移动完成、索引写之前崩溃**（窗口 C）——r5 R1 只测"写失败后回滚"，不测崩溃。
4. **未登记孤儿目录的 sweep 分支**（`host/deleted-sessions.mjs:462-474`）——没有直接测试（293-322 只测已登记条目）。
5. **undo 的 warning 分支**（`indexHeader`/attach 抛错 → ok + warning）——没有测试。
6. **`purgeSessionAccounting` 的吞错分支**（detach/table.delete 抛错）——没有测试（只测了"拒绝删除时不动"）。
7. **transfer 回滚的 `purge: false` 语义**（不清账目）——没有断言账目未被触碰。
8. **`_no-cwd`** 与 **id 编码（`~XXXX`）**——没有测试；phantom 扫描按 raw id 的偏差也没有。
9. **多 profile**（trash 在 A、账目/会话在全局）——没有测试，也没有文档约束。
10. **`.dsh-mkdir-*`** 不在 sweep 白名单——没有测试，等于默认永远不清。

---

## 7. 本机实测快照（`~/.dsh`，Windows）

- `~/.dsh/sessions`：8 个 project 目录（`--C-Users-mcdrme-.dsh-profiles-desktop--`、`--C-mcdrme_files-files-py-CLI-original-version-enhancements--` 等），共 95 个 session 目录；会话文件形如 `session.v4.jsonl.zstd`（该目录只有一个文件，无 `session.lock`——Windows 用命名信号量）。
- `~/.dsh/storages/session_projcache/sessions`：95 条，与 session 目录 id 集合相等（无幽灵）。
- `~/.dsh/storages/workspace.json`：单文件账目（registry 的持久形态）。
- `~/.dsh/profiles/desktop/deleted-sessions/`：目录存在、为空；`original-version-enhancements.deleted.json` 26 字节 `{"version":1,"entries":{}}`。
- `~/.dsh/rewind-snapshots/session-<uuid>`：**按 sessionId 命名的第三方快照目录**，例如 `session-2f4442a9-806e-47c2-bdd2-e24e01ffddfc` 同时存在于 `sessions/--...--/` 与 `rewind-snapshots/`。本插件的删除不碰它 → 删完之后会话字节仍以快照形式存在。
- `~/.dsh/dsh-recall-snapshots/<sha256>`（内容寻址；与 session 的关联**未确认**）、`~/.dsh/cache/attachments/request-images`、`~/.dsh/attachments/v1`（附件，未确认是否随会话删除做 GC）。
- 以某个现存 sessionId 在 `~/.dsh/cache`、`~/.dsh/logs`、`~/.dsh/backups` 里 grep：0 命中（这三处当前不含该 id 的字面量，但这是抽样，不是证明）。

---

## 8. 未确认清单（明确不猜）

1. DSH 启动时是否会为"文件已回位、但 restore 没能 attach/index"的会话重建索引——插件注释承诺"重启后可见"（`host/deleted-sessions.mjs:340-341`），我没有在 DSH 源码里逐行确认这条路径。
2. `dsh-recall-snapshots/<sha256>` 是否包含会话正文、是否与 sessionId 可关联。
3. `~/.dsh/attachments` 与 `cache/attachments` 在会话永久删除后是否做引用计数回收。
4. 是否存在第二个 `DSH_HOME` 的部署形态（本机只测到一个 `~/.dsh`）。
5. Windows 上 `rm` 失败的具体 errno 分布（本机没有构造 `EBUSY/EPERM`）。
6. `session.lock` 残留只在 POSIX；本机是 Windows，未实测 POSIX 形态。
7. 移动成功后 projcache 里的 workspace/cwd 是否立即失效（§3 末尾）。
8. DSH 的 `dsh-session-persistence-jsonl` 导出面里是否存在逐会话删除 API——grep `delete|remove` 只命中内部 Map 与临时文件清理，未见对外删除方法；这支持"删除只能由插件直接操作文件系统"，但不是导出面的穷举证明。

---

## 9. 规格必须收口的边界

这些是 issue 应当裁决、而不是实现自己决定的点：

**B1 回收区的"无主字节"时限**
索引不再认识的回收目录，只能在启动时按 mtime>1h 清。要定：应用长期不重启时是否允许它一直存在？是否需要在每次 purge 失败后立刻重试一次、或把失败写进可观测队列？

**B2 purge 的原子性**
当前顺序是"删索引 → rm"，两个失败方向都会产生不一致（窗口 A/B）。要定：是否允许"先 rm、后删索引"（rm 成功但索引写失败 = 可重试的幂等删除），还是引入 tombstone（先标记 `purging` 再删目录，启动时续跑）？

**B3 崩溃残留的归属**
`.dsh-session-delete-*` / `.dsh-session-move-*` / `.ove-transfer-rollback-*` 的 1h 清扫是"猜测式"回收：它假设没有 in-flight 操作。要定：崩溃残留是否必须绑定一个可续跑的日志（而不是靠 mtime），以及 1h 这个数字的依据。

**B4 隔离目录的前缀所有权**
DSH 自己的 `.dsh-mkdir-*` 不在白名单。要定：本插件的 sweep 是否只清自己的前缀（当前如此），谁负责清 DSH 的（DSH 自己？还是本插件扩展白名单）？跨组件清理的边界必须显式。

**B5 多 profile 的账目归属**
会话在全局 `~/.dsh/sessions`，回收区在 `<profileDir>/deleted-sessions`。要定：一个 profile 删掉的会话，其他 profile 是否应该看到"已被永久删除"的状态？至少要让 receipt/undo 的作用域在 UI 上可解释，否则会出现"在 A 里能撤销、在 B 里已经消失"。

**B6 删除的"字节边界"承诺**
`rewind-snapshots/session-<id>` 这类第三方按 id 存字节的目录证明：本插件只能承诺"DSH 会话根 + 自己的回收区"，不能承诺"字节从磁盘消失"。要定：删除报告的措辞与作用域（是否要检查并如实列出已知的旁路存储），以及是否要把"旁路存储"作为已知限制写进 Report 的 disclaimer。

**B7 重复 id 的处置**
DSH `list()` 在重复 id 上整体抛错（`dsh-session-persistence-jsonl/lib/index.js:3136`）。要定：本插件是否应该主动检测重复 id（扫 project 目录）并在删除/移动时给出可诊断的错误，而不是等 DSH 在下次启动时整盘失明。

**B8 phantom 扫描的 id 编码**
按 raw id 扫目录（`host/delete-session.mjs:246`）与 DSH 的 `encodeSegment`（`dsh-session-persistence-jsonl/lib/index.js:858-870`）不一致。要定：是改用 `encodeSegment`（需要跟随 DSH 的编码），还是显式声明"只支持规范 id"并在入口校验。

**B9 账目清理的单一实现**
现在有四处"清账目"：`purgeSessionAccounting`、启动 reconcile、transfer move 成功路径、以及 undo 的重建。要定：是否收口成一个"账目迁移/删除"的服务，避免字段集合继续漂移（transfer 手写版不清 projcache 就是已经发生的漂移）。
