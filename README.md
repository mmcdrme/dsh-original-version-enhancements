# 原版功能增强 / Original Version Enhancements

「原版功能增强」是一个 DSH Web 客户端插件。它在设置里提供一个自己的页面
（设置 → 原版功能增强），用开关控制各项增强，并把官方界面缺少的聊天记录管理集中到同一处。

> Original Version Enhancements is a DSH Web client plugin. It adds its own
> settings page (Settings → Original Version Enhancements) with per-feature
> switches and an archived-session manager.

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

永久删除只接受已归档且未被宿主加载的本机会话；已加载或运行中的会话会被拒绝，
不会为了删除而停止任何任务。

聊天记录管理改编自 [dsh-chat-manager](https://github.com/WSL043/dsh-chat-manager)
v1.5.21（MIT），详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
与原版的差异：不包装 Host 的 Agent 生命周期服务；已加载会话直接拒绝；取消归档走官方
Client 服务而不是额外路由。

## 开关与持久化

- 两个开关（工作步骤展示快捷切换、聊天记录管理）位于插件页顶部，实时生效，无需刷新。
- 关闭「聊天记录管理」会立即移除「已归档会话」设置页与会话右键菜单项；重新开启即可恢复。
- 开关保存在当前浏览器的 `localStorage`（`original-version-enhancements.flags.v1`），
  清除浏览器数据会恢复默认（两项均开启）。

## Host 路由

只在 Host 提供对应服务时注册，缺失时静默降级，不影响插件其余部分：

- `POST /plugins/original-version-enhancements/archives/search` — 归档内容搜索
- `POST /plugins/original-version-enhancements/sessions/delete` — 永久删除
  （需要 `x-dsh-session-delete-confirmation: delete-session` 确认头与同源校验）

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
index.js                  Host 半侧：注册归档搜索与永久删除路由（缺失服务时降级）
client.js                 Web 客户端：插件页、开关、四个 SVG 图标、聊天记录管理 UI
host/archive-manager.mjs  归档内容搜索（改编自 dsh-chat-manager）
host/delete-session.mjs   已归档会话的安全删除（改编自 dsh-chat-manager）
cordis.patch.yml          插入本插件条目
locale/{zh,en}.json       插件管理页标题与描述
icon.svg                  插件管理页图标
THIRD_PARTY_NOTICES.md    第三方许可与改动说明
```
