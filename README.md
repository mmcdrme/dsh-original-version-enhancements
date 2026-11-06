# 原版功能增强 / Original Version Enhancements

「原版功能增强」是一个 DSH Web 客户端插件。它在设置里提供一个自己的页面
（设置 → 原版功能增强），用开关控制各项增强，并把官方界面缺少的聊天记录管理、
自动化任务增强集中到同一处。

> Original Version Enhancements is a DSH Web client plugin. It adds its own
> settings page (Settings → Original Version Enhancements) with per-feature
> switches, an archived-session manager, and an automation enhancement panel.

## 功能 / Features

### 1. 工作步骤展示快捷切换

把「设置 → 通用设置 → 工作步骤展示」的四个档位（简洁 / 标准 / 详细 / 完全展开）
复制成四个 24px 图标按钮，放在「用资源管理器打开」工作区按钮的左侧：

- 会话标题栏：`conversation.session.header.utilities`，`order: -20`
- 右侧文件面板：`sidebar.right.tab.files.actions`，`order: -10`

按钮共享 `ui-chat.transcriptView`，与设置页双向同步。插件页上的「工作步骤展示快捷切换」
开关关闭后，两处按钮立即隐藏，Host 配置保持不变。

### 2. 聊天记录管理

聊天记录管理现在有两个入口：

- **独立设置页**：设置 → 已归档会话。按名称、工作区或聊天内容搜索已归档会话
  （聊天内容搜索最多返回 20 条）；一键「取消归档」，使用官方
  `workspaces.unarchiveSession`；「永久删除」带二次确认。
- **会话右键菜单**：任意会话行的右键菜单新增红色「永久删除」，点击后弹出同一套确认框。

永久删除默认只接受已归档且未被宿主加载的本机会话，并通过持久化写入句柄独占校验。
插件会跟踪 Host 的 Agent 生命周期句柄，可先停用再删除本次插件启动后加载的会话。

如果会话在插件启动前就已加载（没有可用的句柄），确认框会给出「强制删除」：
跳过写入句柄直接移除磁盘上的会话目录。该操作会让宿主中的会话立即失效，
建议删除后重启 DeepSeek Harness；侧边栏的残留行也会在重启后消失。

删除成功后会清理归档标记；插件启动时也会清理「存储已不存在」的归档标记，
避免归档页出现幽灵行。

聊天记录管理改编自 [dsh-chat-manager](https://github.com/WSL043/dsh-chat-manager)
v1.5.21（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
与原版的差异：无法取得句柄时提供显式「强制删除」；取消归档走官方 Client 服务而不是额外路由。

### 3. 自动化任务增强

自动化任务增强把原 `automation-console` 插件的能力并入本插件，并按 DSH 0.2.x
的新版 Schedule 服务与「自动化任务」页的界面重写：

- **与官方页同构的独立面板**：侧栏「自动化增强」（`main` 面板 key 与 `sidebar.panellist`
  id 均为 `original-version-enhancements.automation`，`order: 11`）。标题、`+ 新建`
  按钮、`已开启 / 已暂停 / 已结束 / 全部` 分栏、搜索框、全选、时钟图标的行样式与空态插画
  都对齐官方页；点击任务在右侧打开同款「规则」编辑抽屉（名称 / 内容 / 执行位置 /
  关联工作区 / 重复 / 时间 / 自定义 RRULE / 保存 / 暂停 / 删除）。官方页及其数据不变，
  两处操作同一份任务。
- **分栏计数**：四个分栏后分别以绿、黄、红、黑显示任务数量，数字实时跟随任务表。
- **全选在列表上方**：`全选` 复选框独占一行、位于任务列表之上并与行首勾选框对齐，
  只作用于当前分栏与搜索词命中的任务。
- **免对话创建**：在面板里直接新建任务，不必先进入一段对话；`新建` 打开编辑抽屉。
  新建时默认「重复」勾选、规则为「按分钟、每 30 分钟」，一次性时间默认落在 30 分钟后；
  取消「重复」勾选即只运行一次，此时才显示日期与时间。
- **自定义规则示例**：选择「自定义」时，RRULE 输入框下方给出三条可直接点选填入的示例
  （每周一三五、每两天、每月 1 号），避免手写 RRULE。
- **立即投递**：行内与编辑抽屉都提供「立即投递」，调用宿主 `run` 立即把任务内容投递到
  目标会话；投递成功后行内显示「上次投递」时间。
- **暂停所选**：批量操作栏里的黄色按钮，把所选任务中仍开启的一次性暂停。
- **清除运行记录**：标题栏按钮，二次确认后调用宿主 `deleteInactive`，删除所有已结束任务
  及其运行记录；已开启、已暂停的任务与原会话不受影响。
- **批量删除**：勾选多个任务后一次删除，带二次确认；已投递的消息与目标会话保留。
- **多会话绑定**：勾选一个或多个任务后一次绑定到多个会话（同标题、同指令、同重复规则），
  每个任务 × 每个会话各一份；已归档会话被过滤，已经绑定过的会话自动跳过，
  一次性任务若时间已过则拒绝复制并提示原因。
- **关联会话列表**：只列出正常会话（已归档、以工作区名占位的空会话、同名重复项都不显示），
  避免下拉里出现成片的同名条目。
- **投递后自动清理**：逐任务开关，只有「一次」任务可用（循环任务不显示该开关、不会误删）。
  一次性任务投递完成（状态 `ended` 且有投递回执）后由 Host 侧自动删除；
  宿主 `schedule/changed` 事件与插件启动时都会执行对账。编辑抽屉里的勾选会随保存一起写入。

自动清理状态保存在 profile 目录的 `original-version-enhancements.automation.json`。

## 开关与持久化

- 三个开关（工作步骤展示快捷切换、聊天记录管理、自动化任务增强）位于插件页顶部，实时生效，无需刷新。
- 关闭「聊天记录管理」会立即移除「已归档会话」设置页与会话右键菜单项；重新开启即可恢复。
- 关闭「自动化任务增强」会立即移除侧栏面板与对应面板页；官方「自动化任务」页不受影响。
- 开关保存在当前浏览器的 `localStorage`（`original-version-enhancements.flags.v1`），
  清除浏览器数据会恢复默认（三项均开启）。

## Host 路由

只在 Host 提供对应服务时注册，缺失时静默降级，不影响插件其余部分：

- `POST /plugins/original-version-enhancements/archives/search` — 归档内容搜索
- `POST /plugins/original-version-enhancements/sessions/delete` — 永久删除
  （需要 `x-dsh-session-delete-confirmation: delete-session` 确认头与同源校验）
- `POST /plugins/original-version-enhancements/automation/catalog` — 任务目录与自动清理标记
- `POST /plugins/original-version-enhancements/automation/create` — 新建任务
- `POST /plugins/original-version-enhancements/automation/update` — 修改任务（标题 / 内容 / 规则 / 目标 / 启停）
- `POST /plugins/original-version-enhancements/automation/run` — 立即投递
- `POST /plugins/original-version-enhancements/automation/auto-clean` — 设置/清除任务的自动清理
- `POST /plugins/original-version-enhancements/automation/delete` — 批量删除
- `POST /plugins/original-version-enhancements/automation/clear` — 清除全部已结束任务及其运行记录
- `POST /plugins/original-version-enhancements/automation/bind` — 把任务复制到多个会话

后八条需要 Host 的 `schedule` 服务；未挂载该服务的组合里它们不会注册。

## 安装 / Install

该目录本身就是一个 bundle：

```text
plugin_manager install_bundle <本目录绝对路径>
```

或克隆仓库：

```text
git clone https://github.com/mmcdrme/dsh-original-version-enhancements.git
```

## 结构 / Layout

```text
index.js                  Host 半侧：归档搜索、永久删除、自动化任务增强路由
client.js                 Web 客户端：插件页、三个开关、四个 SVG 图标、聊天记录管理 UI、自动化增强面板
host/archive-manager.mjs  归档内容搜索（改编自 dsh-chat-manager）
host/delete-session.mjs   已归档会话的安全删除（改编自 dsh-chat-manager）
host/automation.mjs       自动化任务增强（批量删除、多会话绑定、投递后自动清理）
cordis.patch.yml          插入本插件条目
locale/{zh,en}.json       插件管理页标题与描述
icon.svg                  插件管理页图标
THIRD_PARTY_NOTICES.md    第三方许可与改动说明
```
