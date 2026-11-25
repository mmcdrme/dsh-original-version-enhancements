# WebView2 多窗口：进程模型、profile 与多 UDF 的事实与成本

- 日期：2026-11-26
- 范围：只回答 WebView2 运行时与官方 API 侧的事实；不含 DSH 服务端行为验证，也不替插件拍板。
- 采信的前提（未复核）：本插件 Host 用 `child_process.spawn` 为每个窗口起一个 `native/OveWindow.exe`（WinForms + WebView2），每窗一个独立 user data folder（UDF）`.webview-data/window-<时间戳>-<随机>`，最多 8 窗，关窗后 `child.kill()` 并重试删目录。
- 证据等级：下文事实均给出主来源（Microsoft Learn 官方文档 / WebView2 API 参考 / MicrosoftEdge 官方仓库 API spec / MDN）。凡标「推断」的段落是本报告基于已引事实的推理，不是官方数字。

## 结论先行

1. **共享一个 UDF 时，浏览器进程、GPU 进程与 utility 等辅助进程只有一套；渲染进程按站点/来源另起，通常每个窗口至少一个。** 一个 UDF 对应一个「WebView2 进程组」，进程组由「单个浏览器进程 + 一个或多个渲染进程 + GPU/Audio 等辅助进程」构成，且整组进程的生命周期挂在浏览器进程上。因此每多开一个 UDF，就多一整套进程组；同一 UDF 内多开窗口，只多渲染进程与窗口本身。（[进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)）
2. **UDF 之间存在硬性串行约束：一个 UDF 同一时刻只能被一个浏览器进程使用。** 官方原文是「a user data folder is only able to be used by one browser process at a time」，且管理 UDF 的文档写「一个 UDF 同一时刻至多一个 WebView2 session」。跨进程共享同一 UDF 是**受支持**的，但要求各进程的 environment 配置完全一致、且在同一登录会话（同一 HDESKTOP）下；配置不一致会让第二个 environment 创建 WebView 对象直接失败。（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)、[ICoreWebView2Environment](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment)）
3. **可以只用一个 UDF + 多 profile 来隔离 cookie，并共享同一个浏览器进程。** 多 profile API（`CreateCoreWebView2ControllerOptions` + `ProfileName`/`IsInPrivateModeEnabled`）从 Win32 SDK **1.0.1210.39** 起提供；同一 UDF 下每个 profile 有独立目录，cookie/preferences/cache 各自独立，同 profile 的多个控件共享同一个 CookieManager。（[多 profile 支持](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)、[ICoreWebView2ControllerOptions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions)）
4. **profile 不是进程隔离边界。** 同一 UDF 下所有 profile 仍在同一个浏览器进程里；浏览器进程退出（`BrowserProcessExited`）会让该 UDF 下所有 WebView 进入 Closed 状态、必须重建，只有渲染进程级的崩溃/卡死才局限在单个 WebView（或单个子 frame）。（[CoreWebView2ProcessFailedKind](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2processfailedkind)）
5. **「共享登录态（cookie）但不共享会话/连接」在 WebView2 侧没有现成开关。** cookie 的作用域就是 profile：同 profile 自动共享 cookie，换 profile 就换掉 cookie；InPrivate 是独立的 off-the-record profile，cookie 不共享。可行途径只有「同 profile + 应用层各自持有不同会话令牌」或「每窗一个 profile + 用 CookieManager 显式搬运 cookie」两条，代价见第 4 节。（[CookieManager](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookiemanager)、[MultiProfile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md)）
6. **每窗一个 UDF 的主要官方可见失败模式是「文件仍被占用导致的删除/重建竞态」，官方给的唯一缓解是「先结束 session、等浏览器进程及全部子进程退出后再删」，并用 `BrowserProcessId` 监视进程退出；此外还有 environment 配置不一致导致创建失败、运行时版本更新与 UDF 串行约束相撞、Evergreen 运行时版本不可锁定。** 官方文档没有针对杀毒软件占用 UDF 的专门指引（见第 5 节的「未取证」）。（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)、[Evergreen vs Fixed](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)）

## 逐条事实

### 1. 同一 UDF 下多窗口：哪些进程共享，哪些各自一套

1.1 「A WebView2 process group is a collection of WebView2 Runtime processes. A WebView2 process group includes the following: A single browser process. One or more renderer processes. Other helper processes, such as the GPU process and the Audio service process.」——进程组里浏览器进程**有且只有一个**。（[进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)）

1.2 「All processes in a WebView2 Runtime processes collection are tied to the browser process, which in turn is associated with a single user data folder. If an application makes use of multiple user data folders, a collection of WebView2 Runtime processes will be created for each of these user data folders.」——**UDF 是进程组的边界**：N 个 UDF = N 套进程组，各自有浏览器进程、GPU 等辅助进程。（同上）

1.3 「When the first WebView2 instance is created for a given user data folder, the browser process ... will be started. All additional processes will be managed by the lifetime of that browser process.」——同一 UDF 的**第一个** WebView 承担启动浏览器进程的开销，后续 WebView 复用该进程。（同上）

1.4 「If you create multiple CoreWebView2Environment objects that are configured the same way (including sharing the same user data folder), they will represent the same user data folder and the same associated collection of processes.」反之，「if they were created with different CoreWebView2EnvironmentOptions.Language values, then the second CoreWebView2Environment will fail to create WebView2 objects. This is true for CoreWebView2Environment objects that are in the same process or in different processes.」——**跨进程共享 UDF 是设计内行为，但环境配置必须逐项一致，否则第二个 environment 直接失败**（同一进程/不同进程都一样）。（同上）

1.5 渲染进程不是「一窗一个」： 「A given renderer process is not associated with a single CoreWebView2 instance, because the renderer process can serve frames in multiple CoreWebView2 instances that use the same user data folder, depending on website isolation.」同时「creating a new WebView2 instance from the same CoreWebView2Environment, but with a different domain in the Source property, will usually start a new renderer process」。渲染进程数量还受 Site Isolation 与「同一 UDF 下被渲染的不同、不相关来源数量」影响。（同上）

1.6 UDF 的取舍被官方明确写成成本项：「Each WebView2 browser process consumes additional memory and disk space. Therefore, avoid running a WebView2 control with too many different UDFs at the same time. Rather than multiple UDFs, you can use multiple profiles to achieve browser data storage separation for different WebView2 controls.」（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)）

1.7 多 profile 的 API spec 把「每控件一个 UDF」的代价写得更直白：那意味着「running multiple browser instances (each including a browser process and a bunch of child processes), which means much more consumption for system resources including memory, CPU footprint, disk space」，并指出同 UDF 下的多个 profile 会共享部分数据（例如 Skia GrContext 的编译着色器缓存、safebrowsing 数据）。（[MultiProfile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md)）

1.8 一个 UDF 同一时刻只被一个浏览器进程使用：「Because a user data folder is only able to be used by one browser process at a time, if you want to use the same user data folder in the WebView using the new version of the browser, you must close the environment and instance of WebView that are using the older version of the browser first.」（[ICoreWebView2Environment](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment)）；UDF 文档对应表述为「Each WebView2 session has exactly one UDF. A UDF can only have at most one WebView2 session at a time.」，紧接着又说「A WebView2 control shares its WebView2 session with any other WebView2 control that uses the same UDF. This is true whether the WebView2 controls are in the same host app or different host apps. However, a UDF may only be shared among host apps that are in the same logon session (more specifically, only one HDESKTOP).」（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)）
> 解读（推断）：「session」在这里指该 UDF 对应的那一个浏览器进程实例，所以「至多一个 session」与「多控件/多宿主进程共享 UDF」并不矛盾——共享是共享同一个 session，不是各开一个。文档没有给出「第二个进程加入」的显式时序图，只给出了「配置不一致就失败」和「必须同一登录会话/桌面」两条硬约束。

1.9 关于「每多一个窗口的内存与冷启动时延量级差多少」：**微软未公布任何每窗口内存或时延数字**。可确证的只有结构（1.1–1.5、1.7）：同一 UDF 内新增窗口的增量是「渲染进程 + 该 WebView 自身」，而每个新增 UDF 的增量是「一整套进程组（浏览器进程 + GPU/Audio/utility 等辅助进程）+ 独立 profile 目录」。据此的**推断**：内存与冷启动的差值主要由「是否新建浏览器进程」决定，同 UDF 的第 2..8 扇窗属于「省掉浏览器进程启动」的量级；跨 UDF 则每窗都要付一遍进程组启动与磁盘目录初始化的成本。此处没有可引用的官方数字，报告中不编造具体 MB/ms。

### 2. 一个 UDF 内多个 profile：能力、最低版本、限制

2.1 能力：「Multiple profile support enables a WebView2 app to have multiple profiles under a single user data folder. Each profile has a dedicated profile folder to save browser data, which provides separate browsing data storage for each user, such as cookies, user preference settings, and cached resources. All the WebView2 controls that are associated with the same user profile share a single profile folder.」（[多 profile 支持](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)）

2.2 用法：`environment.CreateCoreWebView2ControllerOptions()` 得到 options，设置 `ProfileName` 与 `IsInPrivateModeEnabled`，再把 options 传给带 options 的 `Create...Controller`；「If the specified profile doesn't exist, a new profile will be created.」随后可用 `CoreWebView2.Profile` 读写 profile 级信息。（同上）

2.3 最低版本：`ICoreWebView2ControllerOptions` 与 `ICoreWebView2Profile` 的 Applies to 均为 **WebView2 Win32 1.0.1210.39**（preview 1.0.1222）。（[ICoreWebView2ControllerOptions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions)、[ICoreWebView2Profile](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile)）

2.4 约束与坑：
- `ProfileName`「maximum length of 64 characters excluding the null-terminator」，只允许 ASCII 子集（`a-z A-Z 0-9 # @ $ ( ) + - _ ~ . 空格`），不能以 `.` 或空格结尾；大小写不敏感，因为名字会映射成磁盘目录路径。（[ICoreWebView2ControllerOptions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions)）
- 默认 `ProfileName` 是空字符串（即默认 profile），`IsInPrivateModeEnabled` 默认 false；「The profile will be created on disk or opened when calling CreateCoreWebView2ControllerWithOptions ..., and it will be released in memory when the corresponding controller is closed but still remain on disk.」（[MultiProfile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md)）→ **profile 目录会随窗口使用不断累积，不会随窗口关闭自动消失。**
- 同一 profile 名可以「一普通一 InPrivate」并存：「If create a WebView2Controller with {ProfileName="name", InPrivate=false} and then later create another one with {ProfileName="name", InPrivate=true}, these two controllers using the same profile would be allowed to run at the same time.」InPrivate 走的是 Edge 的 off-the-record profile。（同上）
- cookie 归属 profile：「All CoreWebView2s associated with this profile share this same cookie manager」；CookieManager 的改动「would apply to the context of the user profile. That is, other WebViews under the same user profile could be affected.」（[MultiProfile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md)、[ICoreWebView2CookieManager](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookiemanager)）
- 删除 profile 是**异步且可重试**的：「the profile will be marked for deletion. The local profile's directory will be deleted at browser process exit. If it fails to delete, because something else is holding the files open, WebView2 will try to delete the profile at all future browser process starts until successful.」且删除未完成时用同名重建会得到 `HRESULT_FROM_WIN32(ERROR_DELETE_PENDING)`。（[CoreWebView2Profile.Delete](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.delete?view=webview2-dotnet-1.0.4129.50)）
- **不是隔离边界**：多 profile 的描述明确把收益写成「单个 UDF（即运行时单个浏览器实例）内多 profile」，节省的是进程组数量，因此 profile 之间的隔离只到数据层，不到进程层。（[多 profile 支持](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)）

2.5 跨进程注意：profile options 必须由**同一个 environment 配置**得来；如果多个宿主进程要连同一个 UDF，各自的 `CoreWebView2EnvironmentOptions` 必须一致，否则第二个 environment 创建 WebView 失败（见 1.4）。文档没有承诺「不同进程用不同 profile 名」可以绕过配置一致性要求。

### 3. 共享 UDF 时的崩溃影响面与隔离粒度

3.1 失败类型与影响（官方枚举逐条）：
- `BrowserProcessExited`：「Indicates that the browser process ended unexpectedly. The WebView automatically moves to the Closed state. The app has to recreate a new WebView to recover from this failure.」→ **该 UDF 下所有窗口一起失效，且无法在原 WebView 上恢复**。
- `RenderProcessExited`：「the main frame's render process ended unexpectedly. Any subframes in the WebView will be gone too. A new render process is created automatically and navigated to an error page.」可用 `Reload` 或 `Close` 重建。
- `RenderProcessUnresponsive`：脚本死循环/系统繁忙等导致；「The ProcessFailed event will continue to be raised every few seconds until the renderer process has become responsive again.」
- `FrameRenderProcessExited`：「The process exit does not affect the top-level document, only a subset of the subframes within it.」
- `UtilityProcessExited` / `GpuProcessExited` / `SandboxHelperProcessExited`：「The failed process is recreated automatically. This failure is not fatal.」
（以上均见 [CoreWebView2ProcessFailedKind](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2processfailedkind)）

3.2 由于渲染进程可能被多个 CoreWebView2 共享（1.5），**两个窗口若渲染同一站点、又恰好落到同一渲染进程，则该进程崩溃/卡死会同时影响两个窗口**；官方文档对该共享关系只给出「取决于 website isolation / Site Isolation」的定性说法，不承诺一窗一进程。（[进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)）

3.3 正常关闭路径： 「To safely shut down associated browser and renderer processes, use the Close method of CoreWebView2Controller.」——关窗杀进程前应先 `Close` controller。（[进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)）

3.4 隔离粒度相关的可调项：
- `CoreWebView2EnvironmentOptions.ExclusiveUserDataFolderAccess`（默认 false）——「Determines whether other processes can create CoreWebView2Controller from CoreWebView2Environment created with the same user data folder and therefore sharing the same WebView browser process instance.」（[属性文档](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.exclusiveuserdatafolderaccess?view=webview2-dotnet-1.0.2903.40)）这是**唯一一个文档化的「是否允许别的进程加入我的浏览器进程」开关**；它是进程边界，不是「每窗一个渲染进程」的开关。
- 真正把窗口分成不同进程组的做法只有「不同 UDF + 不同 environment」（1.2、1.5）。
- `AdditionalBrowserArguments` 可以把 Chromium 命令行开关传给浏览器进程，但官方明确「If you specify a switch that is important to WebView functionality, it is ignored, for example, --user-data-dir」，且同一 switch 多次出现只取最后一次、`--enable-features`/`--disable-features` 才做合并。（[ICoreWebView2EnvironmentOptions](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions)）文档未承诺 `--renderer-process-limit` 之类开关在 WebView2 中可用。
- `NewWindowRequested`：若既没设 `Handled` 也没设 `NewWindow`，「the target content will be opened on a popup window」；即默认会在**同一浏览器进程**里弹窗，而不是新开进程组；要控制则必须显式设 `NewWindow`（指向另一个已创建的 CoreWebView2）或 `Handled=true`。（[CoreWebView2.NewWindowRequested](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.newwindowrequested?view=webview2-dotnet-1.0.2903.40)）

### 4. 「共享 cookie 但不共享连接/会话」在 WebView2 侧有没有办法

4.1 事实：cookie 的作用域是 **profile**，不是窗口。profile 隔离项明确包含 cookies；同 profile 的多个 WebView 共享同一个 CookieManager，任何 cookie 改动会对同 profile 的所有 WebView 生效。（[多 profile 支持](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support)、[ICoreWebView2CookieManager](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookiemanager)）

4.2 事实：InPrivate 不能用来「共享 cookie」——InPrivate 的 WebView 用的是从普通 profile 派生出的 off-the-record profile（[MultiProfile spec](https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md)），它与普通 profile 的持久 cookie 存储不是同一个。

4.3 事实：窗口之间天然独立的存储只有 `sessionStorage` 一类按顶层浏览上下文分区的东西——「sessionStorage is partitioned by both origin and browser tabs (top-level browsing contexts)」，「Opening a page in a new tab or window creates a new session」。所以「每窗各自的临时状态」不需要任何 WebView2 配置，它本来就是分开的；而 cookie、localStorage、cache 是 profile 级共享的。（[MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage)）

4.4 因此 WebView2 侧能提供的途径只有两条（都只到「可行 + 代价」，不涉及 DSH 服务端是否接受）：
- **途径 A：同 profile，多窗口，靠应用层令牌区分「连接/会话」。** 代价：cookie 自动共享（这正是想要的），但 WebView2 不提供「窗口级 cookie/缓存分区」或「窗口级网络会话」API，两个窗口在浏览器侧是同一个 profile 身份；能否做到「同 cookie、不同连接」完全取决于页面/服务端是否愿意用 URL 参数、header 或 localStorage 里的第二个标识来区分。localStorage 也是 profile 级共享，不能当作隔离手段。
- **途径 B：每窗一个 profile（各自 cookie），把登录凭据用 CookieManager 搬过去。** 可用 API：`GetCookies(uri)`、`CopyCookie`、`AddOrUpdateCookie`，以及 cookie 对象的 `IsHttpOnly`/`IsSecure`/`SameSite`/`Expires`/`IsSession` 等属性。（[ICoreWebView2CookieManager](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookiemanager)、[ICoreWebView2Cookie](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookie)）代价：要在导航前完成搬运并处理失败重试；要逐个复制 `HttpOnly`/`SameSite`/`Secure`/过期时间这些属性，否则服务端会当作另一个会话；会话型 cookie（`IsSession`）无法跨进程持久；cookie 一旦在某个 profile 里被刷新（轮换、登出），其余 profile 需要重新同步，存在竞态窗口。文档没有提供「跨 profile 原子同步 cookie」的 API。

### 5. 每窗一个 UDF 的已知失败模式与官方容错建议

5.1 **删除与文件句柄竞态（官方有明确指引）**：「To delete a user data folder (UDF), you must first end the WebView2 session. You cannot delete a UDF if the WebView2 session is currently active.」以及「If files are still in use after your WebView2 host app closes, wait for browser processes to exit before deleting the user data folder (UDF). In this situation, wait for the browser process and all child processes to exit before deleting the UDF. To monitor processes to wait for them to exit, retrieve the process ID of the browser process by using the BrowserProcessId property.」文档还建议「while a session is running, it's better to call the clear browsing data methods instead of deleting the UDF.」（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)）
> 对「重试 2 次、间隔 1.5s 就删」这类实现的含义（推断）：官方给的是「等进程退出」而不是「定时重试」，定时重试无法保证子进程已退出；`BrowserProcessId` 是文档指名的观测点。

5.2 **同一个 UDF 上 environment 配置不一致 → 创建失败**（同进程或跨进程）；共享 UDF 还必须处于同一登录会话/同一 HDESKTOP。（见 1.4、1.8）

5.3 **运行时更新与 UDF 串行约束相撞**：运行时安装新版本时触发 `NewBrowserVersionAvailable`；「To use the newer version of the browser you must create a new environment and WebView」，但因为一个 UDF 同时只能被一个浏览器进程使用，「you must close the environment and instance of WebView that are using the older version of the browser first. Or simply prompt the user to restart the app.」共享同一 UDF 的控件同样必须全部先关。（[ICoreWebView2Environment](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment)、[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)）

5.4 **运行时版本不可锁定（Evergreen 的固有代价）**：Evergreen 模式「automatically updated」，官方列出的 con 就是「Your WebView2 app cannot specify that a particular version of the WebView2 Runtime is required」；要锁版本只能改用 Fixed Version（自带一份运行时，只有本 app 使用）。（[Evergreen vs Fixed Version](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version)）

5.5 **UDF 创建/权限类错误是「偏致命」的**：官方列出可能出现「User data folder cannot be created because a file with the same name already exists.」「Unable to create user data folder, Access Denied.」「Microsoft Edge runtime unable to start」「Failed to create WebView2 environment」，并建议 `try/catch` 以免应用崩溃；同时警告不要把 UDF 放在网络盘（会变慢、崩溃或丢数据）。（[UDF 管理](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)）

5.6 **若改用 profile 而不删 UDF**：删除 profile 的官方语义是「标记删除 + 浏览器进程退出时删 + 失败则之后每次启动重试」，且删除未完成时同名重建返回 `ERROR_DELETE_PENDING`。（[CoreWebView2Profile.Delete](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.delete?view=webview2-dotnet-1.0.4129.50)）

5.7 **未取证（负面结论，明确记录）**：本次在 Microsoft Learn 的 WebView2 文档范围内没有找到针对「杀毒软件/EDR 扫描占用 UDF 导致删除失败」的专门章节或排除项建议；能引用的只有 5.1 的通用「等进程退出」与 5.5 的错误串清单。若需要杀软侧结论，必须另找主来源（Defender/第三方 AV 文档）或实测，本报告不臆测。

## 对本插件的含义（只陈述影响）

1. **改共享 UDF 会把「8 个独立故障域」变成一个**：任何一次 `BrowserProcessExited` 会同时让全部窗口进入 Closed（3.1），这在当前「每窗一 UDF」下不会发生。收益侧是每窗省掉一整套进程组与冷启动（1.2、1.3、1.6），代价是故障放大与「全部窗口必须一起重启」的运维语义（5.3）。
2. **跨进程共享 UDF 不是 hack，但有前置条件**：每个 `OveWindow.exe` 的 environment options 必须逐项一致，且必须落在同一登录会话/同一桌面（1.4、1.8）。当前是「每窗一个 exe 进程」的结构，这条约束会直接决定能不能共享，而不是 profile 名怎么起。
3. **profile 能解决「cookie 隔离」，解决不了「进程隔离」**：多 profile 让 cookie/缓存按窗口分开且只保留一个浏览器进程（2.1、2.4）；但 profile 崩溃影响面与同 UDF 的进程组一致（3.1、3.2），并且会引入 profile 目录累积与异步删除语义（2.4）。
4. **每 UDF 的删除逻辑需要对照官方容错重估**：官方要求「先结束 session、再等浏览器进程与全部子进程退出」，并以 `BrowserProcessId` 观测（5.1）；「关窗后 kill 再定时重试 2 次」属于另一套假设。若改共享 UDF，则连「删目录」这个动作本身都不再适用，只剩「清 profile / 清浏览数据」的选项（5.1、5.6）。
5. **「一个浏览器会话只允许一条活连接」这个约束，WebView2 侧无法用 profile 绕过**：cookie 是 profile 级、连接/会话身份由应用层决定（4.1、4.4）。要么维持同 profile 由应用层给每个窗口不同令牌，要么走「每窗 profile + CookieManager 搬运 cookie」并接受同步成本（4.4 途径 B）。

## 来源清单

- WebView2 进程模型：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model
- 管理 user data folder：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder
- 单 UDF 下多 profile：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support
- MultiProfile API spec（MicrosoftEdge/WebView2Feedback）：https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/MultiProfile.md
- ICoreWebView2Environment（NewBrowserVersionAvailable / UDF 串行约束）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environment
- ICoreWebView2EnvironmentOptions（AdditionalBrowserArguments 等）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2environmentoptions
- CoreWebView2EnvironmentOptions.ExclusiveUserDataFolderAccess：https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2environmentoptions.exclusiveuserdatafolderaccess?view=webview2-dotnet-1.0.2903.40
- ICoreWebView2ControllerOptions（ProfileName 约束 / 1.0.1210.39）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controlleroptions
- ICoreWebView2Profile：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2profile
- CoreWebView2Profile.Delete（删除重试语义）：https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.delete?view=webview2-dotnet-1.0.4129.50
- CoreWebView2ProcessFailedKind（崩溃影响面）：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2processfailedkind
- CoreWebView2.NewWindowRequested：https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2.newwindowrequested?view=webview2-dotnet-1.0.2903.40
- ICoreWebView2CookieManager：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookiemanager
- ICoreWebView2Cookie：https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2cookie
- Evergreen vs Fixed Version：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version
- MDN sessionStorage（按顶层浏览上下文分区）：https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage
