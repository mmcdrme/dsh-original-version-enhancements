# Windows 子进程生命周期与 WebView2 退出：事实核查

**日期**：2026-11-26 ｜ **范围**：WinForms + WebView2 宿主的优雅退出、父子进程存活判定、user data folder（UDF）删除时机、未响应窗口判定。
**方法**：只采信一手来源（Microsoft Learn 的 Win32 参考 / WebView2 文档 / Node.js 官方文档 / libuv 源码），每条断言附链接。文档没写的地方标为「一手来源未定义」，不补推测。

---

## 结论先行

1. **`child.kill()` 在 Windows 上不是「请求退出」，而是强制终止直接子进程。** Node 文档写明 Windows 上 `SIGTERM`/`SIGKILL`/`SIGINT`/`SIGQUIT` 都是 "terminate the process forcefully and abruptly (similar to 'SIGKILL')"；libuv 的实现是 `OpenProcess(PROCESS_TERMINATE|PROCESS_QUERY_INFORMATION|SYNCHRONIZE)` → `TerminateProcess(handle, 1)`。它不碰子进程树，也就不会碰 `msedgewebview2.exe`。
2. **优雅退出只有 WM_CLOSE 一条有文档语义的路径**（`DefWindowProc` 默认转 `DestroyWindow`；.NET 的 `Process.CloseMainWindow` 就是"给主窗口发一条关闭消息"的封装，主窗口被禁用/不存在时返回 false）。`taskkill` 文档只定义了 `/f`＝强制、`/t`＝连同"由它启动的子进程"，没有定义"不带 /f 就走 WM_CLOSE"。目标窗口一旦未响应，WM_CLOSE 会像别的消息一样卡在队列里——微软文档原话如此。
3. **「WebView2 子进程都退出了吗」没有事件可订阅，只有进程身份可查**：文档给的是 `BrowserProcessId` + "等浏览器进程及其全部子进程退出"。进程模型保证「一个 UDF ↔ 一个浏览器进程，其余进程的寿命挂在它身上」。
4. **PID 复用会真的把孤儿窗口认成有主**：`GetProcessId` 只承诺"进程终止前 PID 在系统内唯一"，终止后不再保证；复用后 `OpenProcess(pid)` 打开的是另一个进程，`GetExitCodeProcess` 返回 `STILL_ACTIVE`。轮询间隔再小也消不掉这个窗口；文档层面更稳的是持有进程句柄（对象在最后一个句柄关闭前一直存在）。
5. **Job Object 能替代轮询，而且 Node 已经默认做了**：libuv 为每个非 detached 的 `spawn` 建一个带 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的全局 job，把子进程和 Node 自己都放进去（源码注释："so windows will kill it when the parent process dies"）。但同一 job 设了 `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`——**只影响显式加入的进程，子进程的子进程不受影响**，所以 WebView2 的孙进程不在这个保护里。
6. **UDF 删除时机没有数值口径**：文档只给两个前置条件（先结束 WebView2 会话；host 关闭后文件可能仍被占用，要等浏览器进程及其全部子进程退出），没有"几秒后句柄释放"的数字，也没有"句柄已释放"的信号。删除失败的观测信号是 `ERROR_SHARING_VIOLATION`(32) / `ERROR_LOCK_VIOLATION`(33)。
7. **未响应的官方边界是 5 秒，且 `IsHungAppWindow` 自称"不供一般使用"**：其定义要求同时满足"不在等输入、不在启动处理中、5 秒内没调用 PeekMessage"；"ghost 窗口永远返回 TRUE"；"5 秒标准可能变"。30s 启动阈值在官方口径里没有对应（启动处理阶段按定义不算 hung），3s 探针短于系统判定阈值。

---

## 1. 如何请求一个 WinForms 窗口优雅退出，以及如何确认 WebView2 子进程真的退出

### 1.1 WM_CLOSE：唯一有文档语义的"请关闭"

- [WM_CLOSE](https://learn.microsoft.com/en-us/windows/win32/winmsg/wm-close)：*"Sent as a signal that a window or an application should terminate."* 默认处理：*"By default, the DefWindowProc function calls the DestroyWindow function to destroy the window."* 应用可以先弹确认再 `DestroyWindow`。
- 因此"优雅"的前提是目标线程还在跑消息循环。未响应时这条路径失效：[Preventing Hangs in Windows Applications](https://learn.microsoft.com/en-us/windows/win32/win7appqual/preventing-hangs-in-windows-applications) 原文：*"clicking the X (Close) button would result in a WM_CLOSE message, which would be stuck in the message queue just like any other message."*

### 1.2 .NET 侧的等价物与一个坑

- [Process.CloseMainWindow](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.process.closemainwindow)：*"Closes a process that has a user interface by sending a close message to its main window."* 返回值：*"true if the close message was successfully sent; false if the associated process does not have a main window or if the main window is disabled (for example if a modal dialog is being shown)."*
- 含义：**返回 true 只代表消息发出去了，不代表窗口关了**；返回 false 时（有模态对话框、或主窗口句柄还没建好）必须另想办法。文档没有"等待关闭完成"的同步保证，要自己等进程/窗口消失。

### 1.3 taskkill：文档只定义了强制和树形

- [taskkill](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill)：`/f` — *"Specifies that processes be forcefully ended."*；`/t` — *"Ends the specified process and any child processes started by it."*；远程一律强制：*"all remote processes are forcefully ended"*。
- **一手来源未定义**：「不带 /f 时 taskkill 会发 WM_CLOSE」。文档没有这句话，只有 `/f` 是"强制"的反向暗示。把"taskkill 不带 /f"当成有保证的优雅退出，属于超出文档的假设。

### 1.4 自定义控制通道

- 跨进程传数据有文档化的消息：[WM_COPYDATA](https://learn.microsoft.com/en-us/windows/win32/dataxchg/wm-copydata)（*"An application sends the WM_COPYDATA message to pass data to another application"*）；命名管道同理。
- 但**"收到之后要退出"的语义是应用自己实现的**，操作系统不背书。要保留"优雅"的保证，最终仍应落到 WM_CLOSE（或应用自己的等价实现）。

### 1.5 Node 的 child.kill() 在 Windows 上到底做了什么

- [Node child_process 文档](https://nodejs.org/api/child_process.html)：*"On Windows, where POSIX signals do not exist, signals are handled as follows. 'SIGKILL', 'SIGTERM', 'SIGINT' and 'SIGQUIT' terminate the process forcefully and abruptly (similar to 'SIGKILL')"*；`SIGWINCH` 会抛 `ENOSYS` 且子进程继续跑；Windows 上不存在的信号名抛 `ERR_UNKNOWN_SIGNAL`。
- [libuv `src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c)：`uv_kill()` 打开句柄 `OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION | SYNCHRONIZE, FALSE, pid)`，再走 `uv__kill()`；后者对 `SIGQUIT/SIGTERM/SIGKILL/SIGINT` 执行 `TerminateProcess(process_handle, 1)`（注释："Unconditionally terminate the process. On Windows, killed processes normally return 1."）。
- [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)：*"Terminates the specified process and all of its threads."*、*"used to unconditionally cause a process to exit"*，并且 *"Otherwise, TerminateProcess is asynchronous; it initiates termination and returns immediately."*
- 边界：文档只说终止该进程及其线程，**没有**"连带子进程"；被终止进程要等 pending I/O 完成或取消才真正退出（*"The terminated process cannot exit until all pending I/O has been completed or canceled."*）。
- 结论：`child.kill()` = 对直接子进程的一次强制终止。孙进程（`msedgewebview2.exe`）不在其作用域内。

### 1.6 确认"真的退出"能观测到什么

- **Node 侧**：`'exit'` 在子进程结束时触发，`'close'` 在 stdio 也关闭之后触发，文档明确 *"The 'close' event will always emit after 'exit' was already emitted"*（[child_process 事件](https://nodejs.org/api/child_process.html)）。这只覆盖直接子进程。
- **进程侧**：持有进程句柄后 `WaitForSingleObject`（句柄需要 `SYNCHRONIZE`，见 [WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)）；或 `GetExitCodeProcess` 判断是否仍为 `STILL_ACTIVE`（[文档](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess)：*"If the process has not terminated and the function succeeds, the status returned is STILL_ACTIVE"*，并提醒应用不要自己把 259 当错误码）。
- **WebView2 侧**：文档不给"退出事件"，只给身份与等待对象——[Manage user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)：*"wait for the browser process and all child processes to exit before deleting the UDF. To monitor processes to wait for them to exit, retrieve the process ID of the browser process by using the BrowserProcessId property"*。
- 进程关系由 [Process model for WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model) 定义：*"All processes in a WebView2 Runtime processes collection are tied to the browser process, which in turn is associated with a single user data folder."*；*"When the first WebView2 instance is created for a given user data folder, the browser process ... will be started. All additional processes will be managed by the lifetime of that browser process."*
- 关闭控件侧：[`CoreWebView2Controller.Close`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.close)：*"Closes the WebView and cleans up the underlying browser instance."*、*"The browser instance is shut down if no other WebViews are using it."*
- **一手来源未定义**：「全部 `msedgewebview2.exe` 已退出」的专有事件或句柄。可用的只有 PID + 进程枚举 + 上面那条"等到进程退出"的文字建议。

---

## 2. 父进程存活检测：PID 复用 vs Job Object

### 2.1 PID 复用为什么会让轮询出错

- [GetProcessId](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocessid) 的 Remarks 只有一句承诺：*"Until a process terminates, its process identifier uniquely identifies it on the system."* ——**终止之后不再保证唯一**。
- [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess) 按 PID 打开进程对象；PID 被回收后，同一个数字指向新进程。
- [GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess) 对新进程返回 `STILL_ACTIVE`。于是"父进程已死、PID 被复用"的场景下，`OpenProcess` + `GetExitCodeProcess` 的每秒轮询会把孤儿窗口判定为"有主"。反向错误同样存在：新进程恰好活着，轮询永远认为父进程还在。
- 文档层面更稳的判据是**句柄而不是 PID**：[Terminating a Process](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)：*"While open handles to kernel objects are closed automatically when a process terminates, the objects themselves exist until all open handles to them are closed."*；*"When a process terminates, its termination status changes from STILL_ACTIVE to the exit code of the process."* [TerminateProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess) 同样说明内核对象在句柄全关前不销毁。
- **一手来源未定义**：PID 复用的最短时间/概率。没有这个数字，就不能说"轮询间隔 1s 足够安全"。

### 2.2 Job Object 的语义（KILL_ON_JOB_CLOSE）

- [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)：*"The job is destroyed when its last handle has been closed and all associated processes have been terminated. However, if the job has the JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag specified, closing the last job object handle terminates all associated processes and then destroys the job object itself. If a nested job has the JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE flag specified, closing the last job object handle terminates all processes associated with the job and its child jobs in the hierarchy."*
- 默认归属：*"After a process is associated with a job, by default any child processes it creates using CreateProcess are also associated with the job."* 可用 `JOB_OBJECT_LIMIT_BREAKAWAY_OK` / `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` 改变；嵌套 job 自 Windows 8 / Server 2012 起支持。
- 赋值接口的限制（[AssignProcessToJobObject](https://learn.microsoft.com/en-us/windows/win32/api/jobapi2/nf-jobapi2-assignprocesstojobobject)）：job 句柄需要 `JOB_OBJECT_ASSIGN_PROCESS`；进程句柄需要 `PROCESS_SET_QUOTA` 和 `PROCESS_TERMINATE`；*"If the process is already associated with a job, the job specified by hJob must be empty or it must be in the hierarchy of nested jobs to which the process already belongs, and it cannot have UI limits set"*；Windows 7 及更早则要求目标进程尚未在 job 中，否则 `ERROR_ACCESS_DENIED`。
- 跨权限/跨完整性级别：由上面的访问权要求决定——低权限调用方拿不到高完整性进程的 `PROCESS_SET_QUOTA`/`PROCESS_TERMINATE` 句柄，UAC 提升的进程无法被普通进程并入自己的 job（这是访问权模型的推论，文档未单列该场景）。

### 2.3 Node 已经默认替你做了这件事（关键事实）

- [libuv `src/win/process.c`](https://github.com/libuv/libuv/blob/v1.x/src/win/process.c) 的 `uv__init_global_job_handle()`：
  - 建 job 并设置 `info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;`
  - 句柄不可继承，注释：*"Since this handle is made non-inheritable and we're not giving it to anyone, we're the only process holding a reference to it. That means that if this process exits it is closed and all the processes it contains are killed."*
  - 它把 **Node 自己**也 `AssignProcessToJobObject(uv_global_job_handle_, GetCurrentProcess())`。
- `uv_spawn()` 里：*"If the process isn't spawned as detached, assign to the global job object so windows will kill it when the parent process dies."* 赋值紧跟 `CreateProcessW` 之后、`uv_spawn` 返回之前完成（非 detached 分支不加 `CREATE_SUSPENDED`；只有 `DETACHED_PROCESS` 分支才加，并在之后 `ResumeThread`）。JS 侧没有机会插到"已 spawn、未入 job"之间，但子进程在这段窗口里确实已经在运行。
- 失败处理：若 `AssignProcessToJobObject` 返回 `ERROR_ACCESS_DENIED`（例如外部 job 控制、旧系统不支持嵌套 job），libuv 直接吞掉错误：*"we just swallow the error and continue without establishing a kill-child-on-parent-exit relationship"*。
- [Node 文档](https://nodejs.org/api/child_process.html)：*"On Windows, setting options.detached to true makes it possible for the child process to continue running after the parent exits."* —— 即 `detached: true` 会绕开上述 job（并另开控制台窗口），代价正是失去"父死子亡"。

### 2.4 代价与限制（针对"用 job 替代轮询"）

1. **孙进程逃逸**：`SILENT_BREAKAWAY_OK` 的语义见 libuv 自己的注释——*"We're setting the JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK flag so only the processes that we explicitly add are affected, and their subprocesses are not."* 所以 job 里只有 `OveWindow.exe`；它启动的 `msedgewebview2.exe` 不在 job 内，job 关闭不会带走它们。
2. **嵌套/外部 job**：宿主进程若已被别的 job 控制且不允许嵌套，赋值失败且（在 libuv 路径上）静默跳过；自己建 job 时要单独处理这个错误。
3. **权限**：需要 `PROCESS_SET_QUOTA`+`PROCESS_TERMINATE`；不同完整性级别、UAC 提升、跨会话的场景需要重新评估。
4. **Node 没有内置 Job API**：核心 `child_process` 的文档只涉及 spawn/stdio/`pid`/`kill`/IPC，没有任何 Job Object 接口（[文档](https://nodejs.org/api/child_process.html)）。要显式建 job，只能走 native addon / FFI（如 koffi）/ 辅助宿主进程，并且**持有 job 句柄的必须是一个活得比子进程久的进程**——否则句柄一关，子进程立刻死。
5. **libuv 也把 Node 自己放进了 job**：外部若对 Node 施加 job 限制，行为会叠加（嵌套 job 语义）。

---

## 3. WebView2 / Chromium 释放 user data folder 句柄：时延与可观测信号

### 3.1 文档给出的两个硬前置条件

[Manage user data folders](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder)：

- *"To delete a user data folder (UDF), you must first end the WebView2 session. You cannot delete a UDF if the WebView2 session is currently active."*
- *"If files are still in use after your WebView2 app closes, wait for browser processes to exit before deleting the user data folder (UDF). Files in UDFs might still be in use after the WebView2 app is closed. In this situation, wait for the browser process and all child processes to exit before deleting the UDF."*（监控手段：`BrowserProcessId`）
- 关闭控件不等于关闭浏览器实例：[`CoreWebView2Controller.Close`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2controller.close) —— *"The browser instance is shut down if no other WebViews are using it."*

### 3.2 时延：没有数字，只有"等进程退出"

- 上述文档没有给任何秒数、重试次数或退避曲线，也没有"文件句柄已释放"的信号/事件。可用的确定性信号只有：浏览器进程 + 全部子进程退出（按 `BrowserProcessId` 追踪）。
- 因此"2 次重试、间隔 1.5s"这类参数**在一手来源里没有任何依据**；它们既不被文档否定，也不被文档支持。

### 3.3 可观测的失败信号

- [系统错误码](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)：`ERROR_SHARING_VIOLATION` 32 (0x20) — *"The process cannot access the file because it is being used by another process."*；`ERROR_LOCK_VIOLATION` 33 (0x21) — *"...another process has locked a portion of the file."*
- Node 侧删除目录会把这些系统错误包成 `EBUSY`/`EPERM`/`ENOTEMPTY`（Node 的映射是 fs 层行为，**一手来源未逐条对照**，属于实现细节而非 Windows 文档）。

### 3.4 文档给的替代路径（不是删除目录）

- 清浏览数据：[同页](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) 提到"clear browsing data"接口可替代直接删 UDF（*"to call the clear browsing data methods instead of deleting the UDF"*）。
- 隔离 cookie 而不开新 UDF：[Support multiple profiles under a single user data folder](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/multi-profile-support) —— *"Each profile has a dedicated profile folder to save browser data, which provides separate browsing data storage for each user, such as cookies, user preference settings, and cached resources."*
- 成本口径：[同页](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) *"Each WebView2 browser process consumes additional memory and disk space. Therefore, avoid running a WebView2 control with too many different UDFs at the same time."*；并建议 *"Rather than multiple UDFs, you can use multiple profiles"*。
- 跨应用共享是**被文档允许**的：[Process model](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model) *"A user data folder can be shared by multiple applications, but be sure to consider the implications on performance and management"*；[UDF 页](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) *"If you launch two copies of your host app, they will use the same UDF."*（该句出现在"每用户安装"的上下文里。）

---

## 4. 未响应（ghost window）判定边界与看门狗阈值

### 4.1 官方定义

- [IsHungAppWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-ishungappwindow)：
  - *"An application is considered to be not responding if it is not waiting for input, is not in startup processing, and has not called PeekMessage within the internal timeout period of 5 seconds."*
  - *"Ghost windows always return TRUE."*
  - *"The Windows timeout criteria of 5 seconds is subject to change."*
  - 页面顶部标注：*"[This function is not intended for general use. It may be altered or unavailable in subsequent versions of Windows.]"*
- [Preventing Hangs in Windows Applications](https://learn.microsoft.com/en-us/windows/win32/win7appqual/preventing-hangs-in-windows-applications)：*"The operating system detects this state by attaching a timer to pending messages in the message queue. If a message has not been retrieved within 5 seconds, the DWM declares the window to be hung."*

### 4.2 ghost window 到底是什么（有文档的部分）

- 同一篇 [Preventing Hangs](https://learn.microsoft.com/en-us/windows/win32/win7appqual/preventing-hangs-in-windows-applications)：DWM *"seamlessly hiding and then replacing the hung window with a 'ghost' copy displaying a bitmap of the original window's previous client area (and adding "Not Responding" to the title bar)"*；*"the user can only move, minimize, and - most importantly - close the unresponsive application, but not change its internal state"*；DWM 还与 Windows Error Reporting 集成，允许用户关闭并可选重启应用。
- 也就是说：**ghost window 是 DWM 托管的一份位图副本，不是原窗口**；用户点它的关闭按钮走的是 WER 的终止路径，不是应用的 `WM_CLOSE` 处理逻辑（后者已经卡在队列里）。

### 4.3 判定边界

- 判定对象是**窗口/线程**，不是进程：需要窗口 + 线程消息队列（*"When an application (or more accurately, a thread) creates a window on the desktop..."*）。
- **启动处理阶段明确排除**在"未响应"之外（见 4.1 的三条件）。因此用"5 秒无响应"来判"启动失败"与官方定义不一致；30s 启动阈值在一手来源中没有对应物。
- 探针类 API（[`SendMessageTimeout`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendmessagetimeouta)）的返回 0 只表示"失败或超时"：*"If the function fails or times out, the return value is 0"*，且 *"the function does not always call SetLastError on failure"*。用超时当"hung"的判据，阈值低于 5s 时与系统判定不一致（系统可能仍认为它正常）。
- 阈值对照表：

| 阈值（插件现用） | 一手来源里的对应物 | 结论 |
|---|---|---|
| 30s 启动超时 | 无。官方只说"startup processing"不计入未响应 | 文档不支持也不反对；不能拿 IsHungAppWindow 论证 |
| 3s 探针（消息未答） | 官方 5s 判定线，且"subject to change" | 3s 短于系统判定，属插件自定义口径 |
| 5s 未答 | 与 DWM/IsHungAppWindow 的 5s 同量级 | 量级一致，但官方明确该值可变 |

### 4.4 强制结束与 Alt+Tab 残影

- 有文档的部分：`TerminateProcess` 无条件终止进程及其线程，并且是异步的（[链接](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)）；DWM 在窗口 hung 时接手显示 ghost 副本，用户通过它关闭应用（[链接](https://learn.microsoft.com/en-us/windows/win32/win7appqual/preventing-hangs-in-windows-applications)）。
- **一手来源未定义**：「TerminateProcess 之后 Alt+Tab / 任务栏是否立刻移除条目」「残影持续多久」。本轮在 Microsoft Learn 未找到规定该行为的页面；shell（explorer）的窗口枚举与 DWM 的合成状态都不在这几篇文档的范围内。这一条只能作为待验证的观测问题，不能写成事实。

---

## 5. 对本插件的含义（只陈述影响）

1. **现在的 `child.kill()` 只保证 `OveWindow.exe` 被强制终止，不保证 `msedgewebview2.exe` 退出**；而 UDF 删除的官方前置条件恰恰是"浏览器进程及其全部子进程退出"。因此"kill → 2 次重试 × 1.5s → 删目录"的失败概率取决于孙进程何时消失，而不是重试次数。
2. **`--parent-pid` 轮询存在双向误判**：父进程死后 PID 被复用，孤儿窗口会被认成"有主"（`GetExitCodeProcess` 返回 `STILL_ACTIVE`）；反过来，如果只靠 PID 而没有句柄，也没有任何"父已死"的确定性信号。libuv 的全局 job 已经覆盖了"Node 崩溃 → `OveWindow.exe` 被杀"这一半，但**不覆盖孙进程**，因为 `SILENT_BREAKAWAY_OK` 让子进程的子进程留在 job 外。
3. **每窗一个 UDF 的成本有官方口径**：一个 UDF 对应一个浏览器进程，每个浏览器进程额外占内存和磁盘，文档明确建议"避免同时开太多 UDF"，并给出"同一 UDF 下多 profile"作为隔离 cookie 的替代方案。8 窗 × 独立 UDF ＝ 8 个浏览器进程。
4. **"共享 cookie jar 会让第二个窗口卡在欢迎页"不是 WebView2 的限制**：文档明确 UDF 可被多个应用共享、同机多份宿主会指向同一个 UDF，进程模型也只说"一个 UDF ↔ 一个浏览器进程"。这是应用层会话/登录态的后果，WebView2 侧的真实边界是"进程寿命挂在浏览器进程上"和"会话活跃时 UDF 不可删"。
5. **看门狗的阈值与官方口径只在 5s 这一点上对齐**：3s 探针短于系统 hung 判定，30s 启动阈值在"启动处理不算未响应"的定义下没有依据；且窗口一旦真 hung，WM_CLOSE 会卡在队列里，此时"优雅退出"这条路径本身已经不可用，只能走强制终止（并承担孙进程/UDF 的后果）。

---

## 附：本轮取证缺口（明确未验证，避免被当成事实）

- Chromium 侧的 UDF 文件锁实现（ProcessSingleton / `SingletonLock` 等）：`chromium.googlesource.com` 在本环境不可达，`raw.githubusercontent.com/chromium/chromium` 的对应路径返回 404，故**未取证**。本文关于 UDF 的结论只来自 WebView2 官方文档。
- PID 复用时间窗、Windows 回收 PID 的具体策略：Microsoft Learn 未给出，本文只引用"终止前唯一"这一条承诺。
- Alt+Tab/任务栏残影：未找到规定该行为的一手文档（见 4.4）。
- Node 的 `fs.rm` 系统错误到 `EBUSY`/`EPERM` 的映射：属 Node 实现细节，本文未逐条对照。
- libuv 行为以 v1.x 当前源码为准；不同 Node 版本捆绑的 libuv 可能不同，落地前应对照实际发行版。
