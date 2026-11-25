# WebView2 共用 UDF：缓存复用、cookie 隔离与免两跳直达

- 关联 issue：GitHub issue #19（标签 `wayfinder:research`）
- 调研日期：2026-11-26
- 一手来源范围：Microsoft Learn 的 WebView2 API 参考与概念文档、WebView2 SDK release notes、Chromium 官方文档、RFC 6265bis、本仓源码，以及本机 WebView2/Edge 的 UDF 目录实测。
- 每条断言后附官方链接（或源码 `文件:行`）。推断与未验证处显式标注「未确认」。

## 0. 结论速览

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 同 UDF 多 profile 是否隔离 cookie/localStorage？ | 是。每个 profile 有独立 profile 文件夹，cookie、偏好、缓存资源都按 profile 分开。 | [multi-profile-support](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)、[CookieManager 备注](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager) |
| HTTP cache / code cache 是否在 profile 间共享？ | 不共享。二者都在 profile 目录内（`Default/Cache`、`Default/Code Cache`）。UDF 根目录下共享的是 ShaderCache、Local State、Crashpad 之类，不是页面缓存。 | 官方「缓存资源按 profile 分开」+ Chromium [user_data_dir.md](https://github.com/chromium/chromium/blob/main/docs/user_data_dir.md)（Windows 上 user cache dir 就是 profile dir）+ 本机目录实测（§1.4） |
| 「一个浏览器会话一条连接」按 profile 还是 UDF 计？ | 不是 WebView2 的约束。WebView2 只规定「一个 UDF = 一个 browser process」。连接/session 的计数是本产品自己的应用层规则。 | [process-model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model) + 本仓注释 `host/native-window.mjs:176-178` |
| 首次导航前能否预置 cookie？ | 可以：`EnsureCoreWebView2Async` 返回后、`Navigate` 之前用 `CookieManager` 写入。域/路径必须匹配，`Domain`/`Path` 创建后只读。 | [CreateCookie](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager.createcookie)、[AddOrUpdateCookie](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager.addorupdatecookie) |
| 能否免两跳？ | 只有「预置 cookie + 单次 Navigate」这条路成立。`NavigationStarting` 改不了 URI；`NavigateWithWebResourceRequest` 明确不覆盖 Cookie 头；`SetVirtualHostNameToFolderMapping` 只能映射静态目录。 | 见 §3 |
| 1.0.1210.39 之前？ | 没有 profile API，只能每窗独立 UDF（= 每窗一个 runtime 实例）。 | [SDK 1.0.1210.39 发布说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-1210-39) |
| 能否用 `--profile-directory`？ | 没有官方支持；profile 选择的正规入口是 `ProfileName`（按 controller 创建时指定）。 | [AdditionalBrowserArguments](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.additionalbrowserarguments) |

---

## 1. 同一 UDF 下多个 profile：什么隔离、什么共享

### 1.1 profile API 从 1.0.1210.39 开始

`CoreWebView2ControllerOptions.ProfileName` 的 "Applies to" 从 **1.0.1210.39** 起（此前没有）。Release notes 原文：*"Multiple user profiles — Support for multiple user profiles in WebView2."*，并声明 *"For full API compatibility, this Release version of the WebView2 SDK requires WebView2 Runtime 101.0.1210.39 (May 9, 2022) or later."*
来源：[CoreWebView2ControllerOptions.ProfileName](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controlleroptions.profilename)、[Release SDK 1.0.1210.39](https://learn.microsoft.com/en-us/microsoft-edge/webview2/release-notes/sdk/1-0-1210-39)

WinForms 侧的入口是 `EnsureCoreWebView2Async(CoreWebView2Environment, CoreWebView2ControllerOptions)` 重载（同版本起）。
来源：[WebView2.EnsureCoreWebView2Async](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.webview2.ensurecorewebview2async)

### 1.2 隔离边界就是 profile 文件夹

官方多 profile 文档：*"Each profile has a dedicated profile folder to save browser data, which provides separate browsing data storage for each user, such as cookies, user preference settings, and cached resources. All the WebView2 controls that are associated with the same user profile share a single profile folder."*
来源：[Support multiple profiles under a single user data folder](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)

同一页也点名了旧的「每窗一个 UDF」做法的代价：*"you must run multiple WebView2 runtime instances (each including a browser process and a bunch of child processes), which consumed more system resources including memory, CPU footprint, and disk space."* —— 这正是本仓现状（`host/native-window.mjs:179`）在文档层面的成本确认。

Cookie 的作用域同样是 profile：`CoreWebView2CookieManager` 备注 *"The changes would apply to the context of the user profile. That is, other WebViews under the same user profile could be affected."*
来源：[CoreWebView2CookieManager](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager)

profile 的生命周期：*"The profile will be created on disk or opened when calling CreateCoreWebView2ControllerAsync ... and it will be released in memory when the corresponding CoreWebView2Controller is closed but still remain on disk. ... the profile name can be reused."*
来源：[CoreWebView2Environment.CreateCoreWebView2ControllerOptions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environment.createcorewebview2controlleroptions)

### 1.3 进程组按 UDF 计，不按 profile 计

官方进程模型：*"All processes in a WebView2 Runtime processes collection are tied to the browser process, which in turn is associated with a single user data folder. If an application makes use of multiple user data folders, a collection of WebView2 Runtime processes will be created for each of these user data folders."* 以及 *"When the first WebView2 instance is created for a given user data folder, the browser process ... will be started."*
来源：[Process model for WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)

同一页还给了两个对本仓直接相关的约束：

- **UDF 内所有 WebView 共享一个 browser process** —— 所以「共用 UDF + 多 profile」把每窗一个 runtime 实例降为「一个 browser process + N 个 profile」。收益是内存/CPU/句柄，代价是故障域合并（§6）。
- **EnvironmentOptions 必须一致**：*"If you try to create a CoreWebView2Environment using a user data folder which another CoreWebView2Environment is already using, and you don't configure the two CoreWebView2Environment objects the same ... then the second CoreWebView2Environment will fail to create WebView2 objects."*

UDF 的归属还有一条日志会话限制：*"A UDF can only have at most one WebView2 session at a time. A WebView2 control shares its WebView2 session with any other WebView2 control that uses the same UDF. This is true whether the WebView2 controls are in the same host app or different host apps. However, a UDF may only be shared among host apps that are in the same logon session (more specifically, only one HDESKTOP)."*
来源：[Manage user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)

→ 本仓的 8 个 `OveWindow.exe` 属于同一用户、同一桌面，因此共用 UDF 在文档允许范围内，且会并入同一个 browser process。

### 1.4 缓存到底在哪个目录（实测 + Chromium 文档）

Chromium 官方文档：*"On Windows and ChromeOS, the user cache dir is the same as the profile dir. (The profile dir is inside the user data dir.)"*，且 *"Each profile is a subdirectory (often Default) within the user data directory."*
来源：[chromium/docs/user_data_dir.md](https://github.com/chromium/chromium/blob/main/docs/user_data_dir.md)

本机实测（Windows 11，WebView2 SDK 1.0.2592.51；UDF 取自本仓 `.webview-data/EBWebView`）：

- UDF 根（`EBWebView/`）：`Local State`、`ShaderCache`、`GrShaderCache`、`GraphiteDawnCache`、`Crashpad`、`BrowserMetrics`、`Variations`、`component_crx_cache`、`extensions_crx_cache`、`hyphen-data`、`OriginTrials`、`SmartScreen`、`Trust Protection Lists`、`ZxcvbnData`、`Speech Recognition`、`PKIMetadata` 等。
- profile 内（`EBWebView/Default/`）：`Cache`、`Code Cache`、`Network/Cookies`、`Local Storage`、`Session Storage`、`IndexedDB`、`GPUCache`、`DawnGraphiteCache`、`DawnWebGPUCache`、`Shared Dictionary`、`blob_storage`、`WebStorage` 等（Edge 157 的 `User Data` 目录结构相同，作为交叉验证）。

→ **HTTP cache 与 V8 code cache 都在 profile 目录里，因此 profile 之间不复用**；多 profile 主要复用 UDF 根上的 GPU shader cache、组件数据与崩溃上报，以及「少起 N 个 browser process」这一项。想要「窗口 A 访问过的页面让窗口 B 首帧更快」，靠共享 UDF 并不成立 —— 除非共享的是**同一个 profile**，而那又会共享 cookie（§1.2）。

### 1.5 「一个浏览器会话只有一条连接」按什么计？

这条不是 WebView2 的规则。本仓注释把原因写在自己的 Host 上：*"Each window needs its own WebView2 profile: the Host grants one browser session a single live connection, so a shared cookie jar would leave the second window waiting on the welcome screen forever."*（`host/native-window.mjs:176-178`）。即：约束的键是**产品自己的 browser session（由 session cookie 认定）**，所以「按 profile 计」就是「按 cookie jar 计」。
另有同源连接池的旁证在 `host/embed.mjs:201-212` 的注释（同一 origin 的连接池会被 SSE / 长轮询占满）。

- Chromium 的 per-origin socket pool 是每个 profile 的网络上下文各自一份 —— 这一点**未确认**（没找到官方一手文档明确表述；`net/socket/client_socket_pool_manager.cc` 在本环境的抓取失败）。规格里不要把它当作已知事实。

---

## 2. 首次导航前预置 cookie

### 2.1 时机：可行，且本仓顺序已经就位

`CoreWebView2.CookieManager` 随 CoreWebView2 一起可用；本仓 `OveWindow.cs:299` 先 `EnsureCoreWebView2Async(environment)`，`OveWindow.cs:326` 才 `Navigate(options.BootUrl)`，中间有一整段同步设置代码 —— 预置 cookie 的插入点就在这里（`OveWindow.cs:301-325`）。
来源：[CoreWebView2.CookieManager](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.cookiemanager)（CookieManager 属 CoreWebView2 成员）、[EnsureCoreWebView2Async](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.winforms.webview2.ensurecorewebview2async)（Task 完成即 CoreWebView2 可用）

### 2.2 字段约束

`CreateCookie(name, value, domain, path)`：

- *"This only creates a cookie object and it is not added to the cookie manager until you call AddOrUpdateCookie."*
- *"A name that starts with whitespace(s) is not allowed."*
- 域与路径在**创建时**传入；`CoreWebView2Cookie.Domain` 与 `.Path` 是只读（"Gets the domain / Gets the path"），其余可写：`Value`、`Expires`、`IsHttpOnly`、`IsSecure`、`SameSite`。
  —— [CoreWebView2Cookie](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookie)

`AddOrUpdateCookie(cookie)`：

- *"may overwrite cookies with matching name, domain, and path if they exist."*
- *"This method will fail if the domain of the given cookie is not specified."*
  —— [AddOrUpdateCookie](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookiemanager.addorupdatecookie)

`IsHttpOnly` 可写，因此 CookieManager 可以种 HttpOnly cookie（JS 读不到，但浏览器照常随请求发送）：
来源：[CoreWebView2Cookie.IsHttpOnly](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookie.ishttponly)

`SameSite` 可写，**默认 Lax**：
来源：[CoreWebView2Cookie.SameSite](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2cookie.samesite)

### 2.3 失败模式清单

1. **域不匹配**：cookie 只随匹配 host 的请求发送。本仓服务在 `127.0.0.1:<port>`（`host/native-window.mjs:162-165`），`127.0.0.1` 与 `localhost` 是两个不同 host，不能混用。
2. **路径不匹配**：页面在 `/plugins/original-version-enhancements/window`（`host/native-window.mjs:22,165`），若 cookie 的 `Path` 设成子路径，页面对 `/api/*` 的请求不会被带上。
3. **`SameSite=None` 且非 Secure**：按 RFC 6265bis §5.4，这样的 cookie 必须被整体忽略。来源：[RFC 6265bis](https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis)。本地是 http（非 TLS），若产品要求 `SameSite=None`，就必须依赖「`localhost`/`127.0.0.1` 视为安全上下文」这一特殊处理 —— **本环境未确认 Chromium 对 `127.0.0.1` 上的 Secure cookie 是否放行，需实测**。
4. **session cookie 随 browser process 消失**：默认 `IsSession = true`，不设 `Expires` 的 cookie 不落盘。共用 UDF 后，最后一个窗口关闭 = browser process 退出，cookie 也就没了；下一个窗口必须重新种。这既是成本（每次都要种），也是安全特性（不落盘）。
5. **写入与导航的时序**：`AddOrUpdateCookie` 是同步签名，但 cookie 实际存在网络服务里；官方没有承诺「返回即对下一次 Navigate 生效」。**未确认**。建议规格里加一条可观测栅栏：写完用 `GetCookiesAsync(目标 URL)` 读回校验再 `Navigate`（同一网络服务的往返，完成即说明前面的写入已生效 —— 这是推断，需实测）。

---

## 3. 免两跳：三条路各自成立吗

现状是两跳：`Navigate(bootUrl)`（带 token，换 cookie）→ `NavigationCompleted` 里 `Navigate(appUrl)`（`OveWindow.cs:326`、`OveWindow.cs:433-438`），中间第一跳渲染的是完整 shell（`OveWindow.cs:224-226` 注释自认这一点）。

### 3.1 预置 cookie + 单次 Navigate（唯一成立的主路径）

依据：`/window` 路由本身**只依赖请求携带的 cookie**，不依赖 token —— `host/embed.mjs:399-405` 用调用者的 `cookie` 头去 fetch `/` 取 index，再注入脚本返回。所以只要 cookie 先在 cookie jar 里，直接 `Navigate(appUrl)` 就能拿到同一份页面。

- 代价：需要知道 cookie 的 **name / domain / path / SameSite / Secure / HttpOnly / Expires**（这些是 DSH Host 侧的约定，本仓代码里看不到，见 §7 未确认项）；cookie 必须由可信来源给出值（不能把 token 拼进 URL）。
- 风险：种 cookie 失败时必须显式报错，否则就是白屏（现状 `ShowLoadFailure`，`OveWindow.cs:441-457`）。
- 顺带收益：token 可以完全不进 URL，也就不进 exe 的 argv。

### 3.2 `NavigationStarting`：改不了地址，只能取消

`CoreWebView2NavigationStartingEventArgs` 的 `Uri` 是 *"Gets the uri of the requested navigation"*（只读），可写的只有 `Cancel`。所以它不能把「/ + token」重写成「/window?session=」，只能「取消 + 再发起一次 Navigate」—— 那仍是两次导航，且第一次要面对取消后的空白/错误态。
来源：[CoreWebView2NavigationStartingEventArgs](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2navigationstartingeventargs)

→ **不能免跳**。

### 3.3 `WebResourceRequested`：能改请求头，但不落 cookie jar

`CoreWebView2WebResourceRequest.Headers` 文档写明是 *"Gets the mutable HTTP request headers"*，因此可以在首个文档请求上补 `Cookie` 头。
来源：[CoreWebView2WebResourceRequest](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2webresourcerequest)、[WebResourceRequested](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.webresourcerequested)（必须先 `AddWebResourceRequestedFilter`，否则事件不触发）

代价与风险：

- 头只对这一条请求生效，**不写进 cookie jar**：后续子资源、SSE、WebSocket 都要各自补头（WebSocket/SSE 是否被 `WebResourceRequested` 覆盖**未确认**）。
- 重定向链路上补的头会丢失（社区案例：302 之后 Cookie 头丢失，最终只能改用 `CreateCookie`+`AddOrUpdateCookie` 解决）。这不是一手来源，仅作风险提示。
- 用 deferral 阻塞请求会把首帧推迟到 handler 返回。

→ 可作为兜底，不建议作为主路径。

### 3.4 `NavigateWithWebResourceRequest`：官方明确不覆盖 Cookie 头

*"The headers in the CoreWebView2WebResourceRequest override headers added by WebView2 runtime **except for Cookie headers**."* 同页还警告自定义头会随每次重定向发送并被写进历史记录。
来源：[CoreWebView2.NavigateWithWebResourceRequest](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.navigatewithwebresourcerequest)

→ 想靠它把会话塞进首个请求：**不成立**。会话只能来自 cookie jar（§3.1）。

### 3.5 `SetVirtualHostNameToFolderMapping`：只能服务静态目录

*"documents loaded in the WebView can use HTTP or HTTPS URLs at the specified host name ... to access files in the local folder"*；只能映射文件夹，不能挂动态路由。
来源：[SetVirtualHostNameToFolderMapping](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.setvirtualhostnametofoldermapping)

而 `/window` 是**服务端注入**的 HTML（`host/embed.mjs:353-372` 在 Host 的 index 里插入 script/style），要么先落盘（多一份过期副本），要么放弃。更关键的是：虚拟主机是**另一个 origin**，与应用 origin（`127.0.0.1:port`）不同源 → 页面里的 `/api/*`、SSE 会跨源，且 `<base href="/">`（`host/embed.mjs:357`）会把相对路径全部指向虚拟主机。

→ 只适合纯静态壳，不适合带会话的应用页。

### 3.6 token 的暴露面（现状）

- boot URL 形如 `...?token=x`（测试 `test/native-window.test.mjs:43`，实现 `host/native-window.mjs:163`）。
- 整个 boot URL 通过 `--url <bootUrl>` 进入子进程 argv（`host/native-window.mjs:41-50,184-191`，解析在 `OveWindow.cs:156`）→ 同用户任意进程可读命令行。
- 它同时是 WebView2 的一次顶级导航，会进浏览历史。

→ 采用 §3.1 后，这些暴露面都可以消掉；规格应把它写成硬约束。

---

## 4. 降级：1.0.1210.39 之前的运行时

- profile 相关 API（`ProfileName`、`CreateCoreWebView2ControllerOptions`、`EnsureCoreWebView2Async(env, options)`）全部是 1.0.1210.39 起新增；此前**没有**在单 UDF 内隔离数据的官方手段（见 §1.1 链接的 "Applies to" 最低版本）。
- 版本语义：SDK 1.0.1210.39 对应 Runtime 101.0.1210.39，官方措辞是「full API compatibility 需要该 Runtime 版本或更新」。
- 旧运行时上调用会怎样：这些能力以 COM 接口形式暴露，运行时没有对应接口时 QueryInterface 返回 `E_NOINTERFACE`（COM 语义）。`.NET` 包装层最终抛出的**具体异常类型未确认**（需在旧 runtime 上实测；不能凭猜写进规格）。可观测事实是：**创建带 profile 的 WebView 会失败**。
- 因此降级规则必须是「先测运行时版本，再决定用哪种布局」：`CoreWebView2Environment.GetAvailableBrowserVersionString()` 已在 `OveWindow.cs:578-589` 使用（用于判断运行时是否缺失），同样可用于比较 `101.0.1210.39`。低于门槛 → 回落「每窗独立 UDF」（即现状 `host/native-window.mjs:179`）。

### 4.1 UDF 里哪些可共享、哪些会互相锁

| 类别 | 位置 | 多 profile 共享？ | 说明 |
| --- | --- | --- | --- |
| cookie / localStorage / IndexedDB / Session Storage | `Default/Network/Cookies`、`Default/Local Storage` … | 否（按 profile 隔离） | §1.2、§1.4 |
| HTTP cache / V8 code cache | `Default/Cache`、`Default/Code Cache` | 否 | 同上 |
| GPU shader cache | UDF 根 `ShaderCache`、`GrShaderCache`、`GraphiteDawnCache` | 是 | 实测目录 |
| 全局状态 / 组件数据 / 崩溃上报 | UDF 根 `Local State`、`Variations`、`Crashpad`、`BrowserMetrics`、`component_crx_cache` … | 是 | 实测目录 |
| browser process 本身 | 每个 UDF 一个 | —（profile 不分裂进程） | §1.3 |

「互相锁」这件事在共用 UDF 的场景里**不是 profile 之间的竞争**：一个 UDF 只允许一个 WebView2 session（§1.3），所有窗口并进同一个 browser process，profile 由该进程统一管理。真正会撞锁的是**删除 profile 目录与 browser process 尚未退出**：

- 官方：*"Wait for browser processes to exit before deleting the user data folder (UDF). ... wait for the browser process and all child processes to exit"*，并可用 `BrowserProcessId` 监控。
  —— [Manage user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)
- 本仓已在处理这一点：`dropProfile` 在关闭后重试删除两次、每次间隔 1.5s（`host/native-window.mjs:86-95`）。

---

## 5. `--profile-directory` 能不能用

- `AdditionalBrowserArguments` 文档：*"If you specify a switch that is important to WebView functionality, it is ignored, for example, `--user-data-dir`."*
  —— [CoreWebView2EnvironmentOptions.AdditionalBrowserArguments](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.additionalbrowserarguments)
- profile 的官方选择方式是**创建 controller 时**给 `ProfileName`（§1.1），并按名字映射到磁盘上的 profile 目录（`ProfileName` 文档原文："the profile name will be mapped to the real profile directory path on disk"）。
- `--profile-directory` 是 Chromium/Chrome 浏览器的进程级开关；WebView2 里没有为它背书，且 browser process 是按 UDF 起、profile 是按 WebView 挂的，二者粒度不同。
- 结论：**不要依赖**。它是否真被忽略 —— **未确认**（验证方法：设 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--profile-directory=X`，看 `EBWebView/` 下是否出现 `X` 目录、不同窗口是否共享 cookie）。

---

## 6. 与本仓现状对照

| 现状 | 事实核对 | 确定性 |
| --- | --- | --- |
| 每窗独立 UDF（`host/native-window.mjs:179` 生成 `window-<ts>-<rand>`；`OveWindow.cs:298` `CreateAsync(null, dataFolder)`；目录挑选与写测试见 `OveWindow.cs:669-698`） | 每窗一个 browser process + 一套子进程；最多 8 窗（`MAX_WINDOWS = 8`，`host/native-window.mjs:24`）= 8 个 runtime 实例 | **确定**（官方明说旧办法要多 runtime 实例，见 §1.2） |
| 两跳导航（`OveWindow.cs:326` → `OveWindow.cs:433-438`） | 第一跳渲染完整 shell 后才跳进 `/window`；首次可见内容来自第二跳 | **确定**（代码 + `OveWindow.cs:224-226` 注释） |
| splash 10s 定时揭开（`OveWindow.cs:323-325`） | 揭盖有两条路：页面脚本 post `ove-ready`（`OveWindow.cs:632-635`，发送方是 `host/embed.mjs:108-132` 的 `LOADING_SCRIPT` 在 `window.chrome.webview` 存在时 post；`client.js:4250` 并不发它），以及 10s 定时兜底。页面自身超时是 20s（`host/embed.mjs:165`）——**10s 兜底早于 20s 超时**，慢机器上会先揭盖、露出半成品 | **确定**（定时器 10s < 页面超时 20s 是代码常量比较） |
| `/window` 只认 cookie（`host/embed.mjs:399-405`） | 页面本身不需要 token；token 只用于第一跳换 cookie | **确定**（代码） |
| 每窗唯一 profile + 用完即删（`host/native-window.mjs:86-95`） | 无任何缓存/GPU shader 复用；每窗冷启动 | **确定**（结构决定） |
| WebView2 SDK 版本 | 仓内二进制为 **1.0.2592.51**（`native/Microsoft.Web.WebView2.Core.dll`），远高于 1.0.1210.39；仓里**没有** `.csproj/.sln`，原生工程只以二进制形式提交 | **确定**（本机读取 DLL 元数据；无工程文件是仓库事实） |

### 6.1 哪些成本是确定的，哪些必须实测

**确定（可直接写进规格）**

1. 每窗一个 runtime 实例 → 内存/句柄/磁盘的固定开销，删到「共用 UDF + N profile」后消失（官方定性，非定量）。
2. 两跳意味着**两次顶级导航**，第一跳必定加载一次完整 shell（HTML + 资源 + transport 初始化），这段是纯浪费。
3. 共用 UDF 后 profile 之间**不共享** HTTP cache / code cache（§1.4）→ 别指望它降低首帧网络成本。
4. 共用 UDF 后故障域合并：`BrowserProcessExited` 会带走**所有**窗口（`CoreWebView2ProcessFailedKind.BrowserProcessExited` 文档："The WebView automatically moves to the Closed state"；本仓 `OveWindow.cs:529-537` 收到即 `Close()`）。
5. 10s 兜底与 20s 页面超时的顺序问题（§6 表格）。
6. token 出现在 argv 与导航历史（§3.6）。

**必须实测（不要写死数字）**

1. 共用 UDF 后**首个窗口**的启动时间：首次创建 profile 目录 + browser process 冷启，可能比现状更慢（现状也是冷启，但 profile 目录更小）。
2. 第 2..N 个窗口的启动时间：共享 UDF 时 browser process 已存在，理论上更快 —— 幅度未知。
3. `AddOrUpdateCookie` → `Navigate` 的竞态窗口是否存在（§2.3-5）。
4. 同一 UDF 下多窗口创建的**串行化**程度（同一 browser process 建 profile 是否排队）—— 未确认。
5. Chromium per-origin socket pool 是否按 profile 隔离（§1.5）。
6. 旧运行时上 profile API 失败的具体异常类型与文案（§4）。

---

## 7. 规格必须收口的边界

1. **运行时门槛与检测点**：`GetAvailableBrowserVersionString()` ≥ `101.0.1210.39` 才启用「共用 UDF + profile」；否则回落每窗 UDF。检测点放在创建 environment 之前，且失败要可观测（不能静默走另一条路）。
2. **profile 命名空间与生命周期**：谁命名（建议 `window-<sessionId 派生>` 而不是随机串，便于复用与清理）、谁删除、删除失败如何重试、共享 UDF 下删某个 profile 是否影响其它窗口（文档未禁止，但删除时机必须在 controller 关闭之后）。
3. **故障域合并**：一个 browser process 服务所有窗口 → 规格必须写清「BrowserProcessExited = 全部窗口关闭并重建」，以及重建时的 UI 语义（不能让用户看到 8 个同时白屏）。
4. **cookie 预置的字段契约**：name / domain（`127.0.0.1` vs `localhost`）/ path / SameSite / Secure / HttpOnly / Expires 由谁决定；写入失败如何上报；是否用 `GetCookiesAsync` 读回校验。
5. **EnvironmentOptions 一致性**：所有窗口必须用同一组 options 与同一 UDF，否则第二个窗口创建失败（§1.3）。
6. **token 不再进 argv / URL / 历史**：若采用预置 cookie，`--url` 参数与 `authenticatedUrl` 的用法都要改；同时规定 exe 崩溃日志不得打印 URL。
7. **揭盖条件唯一化**：`ove-ready` / `ove-timeout` / 10s 兜底 / 45s Host 兜底（`host/native-window.mjs:26`）四者谁优先，必须定死；当前 10s 早于页面 20s 超时是明确的顺序缺陷。
8. **窗口数上限与资源模型**：`MAX_WINDOWS = 8` 现在等于 8 个 runtime 实例；共用后等于 8 个 profile + 1 个 browser process，上限是否需要调整要一起定。

---

## 8. 未确认（不要当结论用）

1. **DSH Host 的会话 cookie 具体属性**（名字、Domain、Path、SameSite、Secure、HttpOnly、TTL）。本仓只有 `authenticatedUrl` 的注入点（`host/native-window.mjs:61,163`）和 `?token=` 的测试桩，cookie 由 DSH 宿主侧设置，仓内看不到。→ 免两跳能否落地，取决于这一点，需向 Host 侧确认或抓包实测。
2. **旧运行时（< 1.0.1210.39）上 profile API 的具体失败形态**（异常类型/HRESULT/是否可捕获后回落）。
3. **`AddOrUpdateCookie` 后立即 `Navigate` 是否稳定带上 cookie**；以及 `GetCookiesAsync` 能否作为可靠栅栏。
4. **`127.0.0.1` 上的 `Secure` cookie / `SameSite=None` 是否被 Chromium 放行**（本机是 http）。
5. **`--profile-directory` 是否真被 WebView2 忽略**（文档只点名 `--user-data-dir`）。
6. **Chromium per-origin socket pool 是否按 profile 隔离**（影响「一条连接」约束的计数单位）。
7. **`WebResourceRequested` 是否覆盖 WebSocket / SSE 请求**。
8. **同 UDF 下并发创建多个 profile 的串行化与耗时**。
9. **共用 UDF 的实际收益数字**（首帧 ms、内存 MB）—— 一手文档只给定性结论，必须本机实测。
