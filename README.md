# 工作步骤快捷切换 / Work Steps Quick Switch

一个 DSH Web 客户端插件，把「设置 → 通用设置 → 工作步骤展示」的四个档位
（简洁 / 标准 / 详细 / 完全展开）复制成四个图标按钮，放在「用资源管理器打开」
工作区按钮的左侧。会话标题栏和右侧文件面板标题栏各有一份，两个入口都紧邻
官方 open-in-app 控件。

> A DSH Web client plugin that puts the four Work details levels
> (Compact / Standard / Detailed / Verbose) immediately left of the
> **Open in File Explorer** workspace action, in both the session header
> and the file panel header.

## 行为 / Behavior

- 四个 24px 高的图标按钮组成一组，匹配文件面板标题栏及相邻「用资源管理器打开」
  分体按钮的紧凑尺寸。
- 点击任一图标即写入 `ui-chat.transcriptView`，与设置页共享同一个 Host 配置；
  在设置页切换时，这组按钮也会同步更新。
- 图标按钮带双语提示、`aria-pressed` 状态与键盘焦点环；写入失败时边框会短暂变为
  错误色，并通过隐藏的 `aria-live` 区域报告。
- 只有在 Host 正在提供 `ui-chat` 配置命名空间时才注册，避免在未挂载聊天能力的
  部署里留下孤立控件。

## 位置 / Placement

- `conversation.session.header.utilities` 槽位，`order: -20`，排在官方
  `open-in-app`（order -10）左侧。
- `sidebar.right.tab.files.actions` 槽位，`order: -10`，排在官方
  `open-in-app`（order 0）左侧。

四个 SVG 图标按档位由折叠卡片逐步过渡到展开树。

## 安装 / Install

该目录本身就是一个 bundle。使用 DSH 的插件管理安装：

```text
plugin_manager install_bundle <本目录绝对路径>
```

安装后刷新 Web 页面即可在文件面板标题栏看到这组按钮。

## 结构 / Layout

```text
index.js            Host 半侧（无 Host 行为）
client.js           Web 客户端：槽位注册、四个 SVG 图标、配置读写
cordis.patch.yml    插入本插件条目
locale/{zh,en}.json 插件管理页标题与描述
icon.svg            插件管理页图标
```
