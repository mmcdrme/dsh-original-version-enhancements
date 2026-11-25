# 独立窗口稳定性与体验规格

- 状态：定稿草案 v1
- 日期：2026-11-26
- 来源：地图 [#3](https://github.com/mmcdrme/dsh-original-version-enhancements/issues/3) 的 8 张决策票
- 适用范围：Windows 桌面客户端（DSH）的独立会话窗口

## 1. 范围

本规格定义「独立窗口」的进程、状态、就绪、失败、关闭、降级与体验契约，供实施者改造 `native/OveWindow.cs`、`host/native-window.mjs` 与 `client.js` 的 detached 段。

非目标：页内窗口（panel）的体验改造、会话移动/复制/删除/归档、非 Windows 实现、多显示器/DPI/键盘焦点的细节（见第 14 节）。

## 2. 术语与所有权

| 对象 | 拥有者 | 说明 |
|---|---|---|
| 原生窗口状态 | Host | `GET /window/native/state` 是唯一读源；页面只镜像 |
| 页内窗口 | 页面 | 生命周期 = 文档生命周期，不登记 Host |
| 就绪（ready） | 页面 | 由页面签名，Host 只记录 |
| 进程与 profile | Host | 启动、关闭、回收、清扫 |

术语：**原生窗口** = 由 `OveWindow.exe` 承载的操作系统窗口；**页内窗口** = 主界面里的浮动 iframe；**UDF** = WebView2 user data folder。

## 3. 状态机

原生窗口条目有且只有四个状态：

| 状态 | 含义 | 进入条件 |
|---|---|---|
| `opening` | 进程已起，页面未就绪 | Host 成功 spawn |
| `ready` | 页面已渲染该会话 | 页面 POST `/ready` |
| `closing` | 关闭已请求 | 用户或 Host 发起关闭 |
| `dead` | 进程已结束 | 进程退出 / 超时 / 崩溃 |

`dead` 必须带 `reason`，取值：

`requested`（用户/菜单关闭）、`cancelled`（opening 阶段用户关闭）、`startup-timeout`（就绪超时）、`navigation-failed`（导航失败且重试耗尽）、`crash`（renderer 熔断或浏览器进程退出）、`host-shutdown`（Host 退出）、`parent-gone`（父进程消失）。

不变量：`ready` 只进一次；`dead` 之后的 `/ready` 一律忽略；一个会话最多一个原生窗口。

## 4. 就绪契约

**签名者：页面，且只有页面。**

就绪的定义：会话已选中、`mounted()` 成立（composer 存在、没有 `data-content-phase="loading"`、chat flow 已渲染），且选择稳定两拍。

- 页面 POST `/window/native/ready`，Host 把条目置为 `ready`。
- exe 只在收到同一就绪信号时揭开加载层；**禁止定时自动揭开**。
- 导航完成不等于就绪；Host 不做任何推断。

## 5. 超时与失败

两段预算：

| 阶段 | 预算 | 执行者 | 到期动作 |
|---|---|---|---|
| 浏览器启动 | 30s | exe 看门狗 | 进程自杀，Host 观察到 exit |
| 就绪 | 45s | 页面 + Host 共用一个 deadline | 页面报 `failed`；Host 关闭并回收 |

打开失败（窗口从未存在）返回错误码，不进入状态机：`spawn-failed`、`unsupported`、`too-many-windows`、`forbidden`、`invalid-session`。

运行期失败与可见行为：

| 失败 | 可见行为 |
|---|---|
| `startup-timeout` | 关闭窗口；主界面 toast：原因 + 重试 + 改用页内窗口 + 查看日志 |
| `navigation-failed` | 自动重试 1 次（1.2s 退避）；仍失败同上 |
| `crash` | 关闭窗口；toast 同上 |
| `cancelled` | 不提示、不重试 |
| `requested` | 不提示 |

自动重试只允许导航失败 1 次；其余一律不自动重试。同一会话同一原因只弹一次 toast。

## 6. 关闭与回收

- 关闭 = `taskkill /PID <pid> /T /F`，等 `exit`；**必须关整棵树**，因为 `child.kill()` 只终止直接子进程，`msedgewebview2.exe` 与 UDF 锁会留下。
- profile 删除的前置是浏览器进程及其子进程退出；30s 有界指数重试（以 `ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION` 为信号）。
- 删除失败不阻塞 UI，记录路径留给启动清扫。
- 启动清扫：删除 24h 前或没有对应活进程的 `window-*` 目录。
- 并发上限 8；第 9 个返回 409 `too-many-windows`；不做 LRU 驱逐。
- 父进程看护用 `(pid, 创建时间)` 双元组，1s 一次；libuv 的 job 只作防御，不作为唯一机制。

## 7. 崩溃恢复

| 事件 | 动作 |
|---|---|
| renderer 崩溃 | 800ms 后自动重载；3 次/60s 熔断，之后 `dead(crash)` |
| 浏览器进程退出 | 立即 `dead(crash)` + toast |
| Host 退出 | 窗口由 job / parent watch 终止，`dead(host-shutdown)`，不 toast |
| 父进程消失 | `dead(parent-gone)`，不重开 |

已关闭的窗口不自动重开；重开只能是用户动作。

## 8. 降级

- **只有 `unsupported`**（无 WebView2、非 Windows、spawn 不可用）自动改用页内窗口，并给一次提示。
- `spawn-failed` / `startup-timeout` / `crash` 不自动换形态；toast 提供「改用页内窗口」动作。
- 页内窗口归页面所有，不写 Host 账本；同一会话降级提示只出现一次。

## 9. 体验

- **单一加载层**：窗口内只有「正在载入会话…」+ 进度条，由 `opening` 驱动；无第二层加载画面。
- **失败不在窗口内留错误页**：窗口关闭，宿主页 toast 承担错误展示。
- toast：顶部居中，6s 自动消失，悬停暂停；动作「重试 / 改用页内窗口 / 查看日志」。
- 关闭约 200ms 淡出，不显示「关闭中」画面。
- 多窗：每个窗口自己的标题栏（工作区 / 会话名 / #短ID）与任务栏项。
- 透明度与静音对已开窗口 800ms 内生效；尺寸只对新窗口生效。

原型：`docs/prototypes/detached-window-states.html`（分支 `prototype/detached-window-states`）。

## 10. HTTP 契约

| 路由 | 方法 | 请求 | 响应 |
|---|---|---|---|
| `/window/native/open` | POST | `{sessionId, reason, width, height, opacity, mute}` | `{ok:true}` / `{ok:false, error}`（409 `too-many-windows` / 403 / 400） |
| `/window/native/close` | POST | `{sessionId}` 或 `{all:true}` | `{ok:true}` |
| `/window/native/ready` | POST | `{sessionId}` | `{ok:true}` |
| `/window/native/appearance` | POST | `{opacity, mute}` | `{ok:true}` |
| `/window/native/state` | GET/HEAD | — | `{ok, supported, windows:[{sessionId, openedAt, ready, state, title}]}` |

所有写路由要求同源；请求体上限 8 KB。

## 11. 不变量

1. 原生窗口状态只由 Host 写；页面不写原生状态。
2. 一个会话最多一个原生窗口；一个 UDF 只服务一个窗口。
3. 关闭必须覆盖整棵进程树；profile 删除必须有界且幂等。
4. 主界面在 ≤1 个轮询周期（600ms）内反映真实状态；Host 不可达保留最后已知最多 5s。
5. 页面重载不保留原生窗口的本地标记。

## 12. 可测边界

必须可被 `node --test` 覆盖：Host 的 windowArguments、路由（方法/来源/请求体）、状态机迁移、超时（注入计时器）、8 窗上限、profile 命名与清扫、关闭与回收；页面的纯函数（key 解析、过期、合并规则、状态派生、失败映射）；协议形状与 reason 枚举。

只能手工验收：真窗口开关（到 8）、透明度/静音、DPI 150%、无 WebView2 降级、杀 exe/Host 后的边框与窗口、假死窗口看门狗、失败 toast。每项要有截图或日志证据。

源码锚点测试只用于 exe 侧不变量，并注明为何不能单测。

## 13. 验收判据

- 地图的 8 张票全部关闭；
- 本规格九节齐全，每条决策带理由；
- 除第 14 节的未决项外没有 TBD；
- 合并前 `node --test test/*.test.mjs` 全绿，并按手工清单过一遍。

## 14. 未决与超出范围

未决（雾）：多显示器拖动与 DPI 迁移、任务栏分组、键盘焦点协作、升级兼容（exe 与 Host 协议版本）、性能预算、运行期诊断、会话删除时的窗口联动。

超出范围：页内窗口体验改造、会话管理、自动化/回溯/工作步骤、非 Windows 实现。

## 15. 现状差距（实施前必读）

| 规格要求 | 现状 | 位置 |
|---|---|---|
| 页面签名就绪并通知 exe | exe 只消费 `ove-ready`/`ove-timeout`，全仓无发送方；实际靠 10s splashTimer 揭开 | `client.js`、`OveWindow.cs` |
| 失败即关闭 + toast | 窗口内保留错误页；native 打开失败不降级却也不提示原因路径 | `OveWindow.cs`、`client.js` |
| 关闭杀整棵树 | `child.kill()` 只杀直接子进程 | `host/native-window.mjs` |
| 父进程看护抗 PID 复用 | 仅 `OpenProcess(pid)` | `OveWindow.cs` |
| 单一就绪 deadline | 20s 页面自判 / 30s exe / 45s Host / 45s 页面等待并存 | 三处 |
| 页内窗口与原生窗口按类归属 | `detachedSet` 是 storage 心跳与 Host 状态的并集 | `client.js` |
