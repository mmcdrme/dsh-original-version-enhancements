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
  关联工作区 / 重复 / 时间 / 自定义 RRULE），`保存` 固定在抽屉最下方。官方页及其数据不变，
  两处操作同一份任务。
- **分栏计数**：四个分栏后分别以绿、黄、红、黑显示任务数量，数字实时跟随任务表。
- **全选在列表上方**：`全选` 复选框独占一行、位于任务列表之上，与行首勾选框完全对齐，
  只作用于当前分栏与搜索词命中的任务。
- **免对话创建 / 在会话中创建**：`新建` 是官方页同款的双段按钮——左侧直接打开编辑抽屉
  （免对话创建），右侧下拉提供「在会话中创建」（新开一段会话并填入创建指令）与「手动创建」。
  「重复」下拉与官方页一致——每周 / 周一至周五 / 每天 / 每 N 小时 / 每 N 分钟 / 每月 /
  仅一次（指定时间）/ 自定义规则，并额外提供 **仅一次（延时）**：延时可按分钟或**秒**填写，
  到点只运行一次。时间字段精确到秒（`时:分:秒`）。
  新建默认「仅一次（延时）：30 分钟」；原来的「重复」勾选框已取消，一次性与循环直接由下拉选择。
- **运行历史记录**：编辑已有任务时，抽屉顶部有「编辑任务」和「运行历史记录」（带条数）两个页签，
  运行记录按时间倒序列在第二个页签里（时间 + 目标会话 + **该次投递的任务内容**），
  **只读展示**，不提供删除或隐藏。
- **自定义规则示例**：选择「自定义规则」时，RRULE 输入框下方给出三条可直接点选填入的示例
  （每周一三五、每两天、每月 1 号），避免手写 RRULE。
- **立即投递**：行内与编辑抽屉都提供「立即投递」。实现方式是把任务临时改到「当前时间 + 2 秒」
  执行，由宿主调度器真正触发一次投递，投递完成后立刻把原重复规则写回（暂停中的任务临时开启，
  投递后恢复暂停）——因此这一次投递会像正常触发一样留下完整记录。
- **行内悬浮操作**：浮到任务行上按状态出现绿色「立即投递」、黄色「暂停任务 / 恢复任务」与红色
  「删除任务」（悬停时仍保持红字）；删除任务带二次确认，消息与会话保留。
  动作浮在行的右上角，不占正文宽度；只有真正的鼠标悬停会显示，勾选复选框后不会残留。
- **任务名后的执行位置**：任务名后附带 `任务名 (工作区/会话名)`——工作区为黑色粗体，
  括号、`/` 与会话名不加粗（会话名为蓝色）；缺少其中一项时只显示存在的那一项。
- **彩色操作回执**：保存/恢复/绑定等成功提示为绿色，暂停为黄色，删除为红色，立即投递为中性色，
  4 秒后自动消失。
- **每秒倒计时**：行内「下次计划时间」后的相对时间每秒刷新，不足一分钟显示为「xx 秒后」；
  已暂停的任务同样显示倒计时。
- **列表顶部固定条**：勾选栏、操作回执与错误提示共用同一条 28px 高的通栏条带，
  三者互斥显示；只压缩高度、右侧保持整行宽度，`全选` 与任务列表整体上移贴近搜索框，
  勾选或执行操作时下方列表的高度与位置完全不变。
- **任务下方的说明行**：说明行可使用整行宽度（悬浮按钮浮在右上角，不挤压文字），
  右边界与「删除任务」的右边界对齐，换行更晚。
- **抽屉底部动作**：「立即投递」为绿色、「暂停任务 / 恢复任务」为黄色、「删除任务」为红色，
  三者同为描边 + 浅色底的按钮样式。
- **批量暂停 / 恢复**：批量操作栏里，在「已暂停」分栏显示绿色「恢复所选」（把所选任务重新开启），
  其余分栏显示黄色「暂停所选」；「绑定到多个会话」为蓝色描边样式；成功后自动取消选择。
- **批量删除**：勾选多个任务后一次删除，按钮与「暂停所选」同款描边样式但为红色，带二次确认；
  已投递的消息与目标会话保留。
- **多会话绑定**：勾选一个或多个任务后一次绑定到多个会话（同标题、同指令、同重复规则），
  每个任务 × 每个会话各一份；已归档会话被过滤，已经绑定过的会话自动跳过，
  一次性任务若时间已过则拒绝复制并提示原因。
- **关联会话列表**：只列出正常会话（已归档、以工作区名占位的空会话、同名重复项都不显示），
  避免下拉里出现成片的同名条目。
- **投递后清理（仅一次性任务）**：逐任务开关，只在「仅一次（延时）/ 仅一次（指定时间）」的任务上出现
  （循环任务不显示该开关，避免误删）。一次性任务投递完成（状态 `ended` 且有投递回执）后由 Host 侧删除；
  宿主 `schedule/changed` 事件与插件启动时都会执行对账。编辑抽屉里的勾选会随保存一起写入。

投递后清理的标记保存在 profile 目录的 `original-version-enhancements.automation.json`。
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
- `POST /plugins/original-version-enhancements/automation/catalog` — 任务目录、投递后清理标记与每个任务的记录条数
- `POST /plugins/original-version-enhancements/automation/history` — 单个任务的运行记录
- `POST /plugins/original-version-enhancements/automation/create` — 新建任务
- `POST /plugins/original-version-enhancements/automation/update` — 修改任务（标题 / 内容 / 规则 / 目标 / 启停）
- `POST /plugins/original-version-enhancements/automation/run` — 立即投递
- `POST /plugins/original-version-enhancements/automation/auto-clean` — 设置/清除任务的投递后清理
- `POST /plugins/original-version-enhancements/automation/delete` — 批量删除
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
host/automation.mjs       自动化任务增强（批量删除、多会话绑定、投递后清理）
cordis.patch.yml          插入本插件条目
locale/{zh,en}.json       插件管理页标题与描述
icon.svg                  插件管理页图标
THIRD_PARTY_NOTICES.md    第三方许可与改动说明
```
