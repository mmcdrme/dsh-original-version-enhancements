// Independent conversation window for the DSH desktop client.
//
// The Desktop shell gives plugins no way to create a native window, so this
// small WinForms + WebView2 host is started by the plugin's Host half and is
// completely independent of the main window: it has its own taskbar entry, its
// own minimise/restore, and keeps running while the main window is minimised.
//
// It opens the Host's authenticated URL (which mints the browser cookie) and
// then the plugin's conversation page; that page selects the conversation from
// its `?session=` query. The window follows its parent process: a Host crash or
// upgrade takes every window with it instead of leaving orphans behind.

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;
// The window owns a few worker threads, but `Timer` here always means the
// WinForms one (System.Threading also defines a Timer and the bare name would
// be ambiguous).
using Thread = System.Threading.Thread;
using ManualResetEventSlim = System.Threading.ManualResetEventSlim;

namespace OveWindow
{
    internal sealed class Options
    {
        public string BootUrl = "";
        public string AppUrl = "";
        public string Title = "独立会话窗口";
        public int Width = 1100;
        public int Height = 800;
        public int Opacity = 100;
        public bool Mute = true;
        public string DataDir = "";
        public int ParentPid = 0;
        public string AppearanceFile = "";
        /** How long the embedded browser may take to come up before the window
            closes itself instead of hanging on screen. */
        public int StartupTimeoutSeconds = 30;
    }

    internal static class Program
    {
        // Per-monitor V2 keeps WebView2 on the device pixel grid; without it
        // Windows bitmap-scales the whole window and text turns blurry.
        [DllImport("user32.dll")]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool GetExitCodeProcess(IntPtr handle, out uint code);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern bool CloseHandle(IntPtr handle);

        /**
         * End this process from any thread. A window whose UI thread stopped
         * pumping messages can no longer be closed from the inside, and Windows
         * would leave a frozen frame in Alt+Tab until Explorer restarts; killing
         * the process is the only thing that removes it.
         */
        internal static void HardExit(int code)
        {
            try { Environment.Exit(code); } catch { }
            try { System.Diagnostics.Process.GetCurrentProcess().Kill(); } catch { }
        }

        /** True while the process behind `pid` is still alive. */
        internal static bool ProcessAlive(int pid)
        {
            var handle = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
            if (handle == IntPtr.Zero)
            {
                // 87 = no such process; anything else is an access restriction
                // (a Host at another integrity level) and means it exists.
                return Marshal.GetLastWin32Error() != 87;
            }
            try
            {
                uint code;
                if (!GetExitCodeProcess(handle, out code)) return true;
                return code == 259; // STILL_ACTIVE
            }
            finally
            {
                CloseHandle(handle);
            }
        }


        [STAThread]
        private static void Main(string[] args)
        {
            EnableDpiAwareness();
            Options options;
            try
            {
                options = Parse(args);
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "独立窗口", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            try
            {
                Application.Run(new Window(options));
            }
            catch (Exception error)
            {
                MessageBox.Show(error.Message, "独立窗口", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            finally
            {
                // WebView2 keeps worker threads and a browser process of its own;
                // a closed window must take this process with it, or a headless
                // husk stays behind with nothing on screen to end it.
                HardExit(0);
            }
        }

        private static void EnableDpiAwareness()
        {
            try
            {
                if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
            }
            catch
            {
            }
            try { SetProcessDPIAware(); } catch { }
        }

        private static Options Parse(string[] args)
        {
            var options = new Options();
            for (var index = 0; index < args.Length; index++)
            {
                var name = args[index];
                if (index + 1 >= args.Length) break;
                var value = args[++index];
                switch (name)
                {
                    case "--url": options.BootUrl = value; break;
                    case "--app-url": options.AppUrl = value; break;
                    case "--title": options.Title = value; break;
                    case "--width": int.TryParse(value, out options.Width); break;
                    case "--height": int.TryParse(value, out options.Height); break;
                    case "--opacity": int.TryParse(value, out options.Opacity); break;
                    case "--mute": options.Mute = value != "0"; break;
                    case "--data-dir": options.DataDir = value; break;
                    case "--parent-pid": int.TryParse(value, out options.ParentPid); break;
                    case "--appearance": options.AppearanceFile = value; break;
                    case "--startup-timeout": int.TryParse(value, out options.StartupTimeoutSeconds); break;
                }
            }
            if (options.BootUrl.Length == 0) throw new ArgumentException("缺少 --url 参数。");
            if (options.Width < 480) options.Width = 480;
            if (options.Height < 360) options.Height = 360;
            if (options.Opacity < 30) options.Opacity = 100;
            if (options.Opacity > 100) options.Opacity = 100;
            if (options.StartupTimeoutSeconds < 5) options.StartupTimeoutSeconds = 5;
            if (options.StartupTimeoutSeconds > 120) options.StartupTimeoutSeconds = 120;
            return options;
        }
    }

    internal sealed class Window : Form
    {
        private static readonly Regex TitleSuffix = new Regex(@"\s+[—–-]\s+DeepSeek Harness\s*$", RegexOptions.Compiled);

        private readonly Options options;
        private readonly WebView2 view;
        private readonly Panel splash;
        private readonly Label splashLabel;
        private readonly ProgressBar splashBar;
        private static string explicitDataDir = "";
        private bool switched;
        private bool revealed;
        private bool retried;
        private Timer splashTimer;
        /** Set once the embedded browser started or definitively failed. */
        private readonly ManualResetEventSlim startupDone = new ManualResetEventSlim(false);

        public Window(Options options)
        {
            this.options = options;
            Text = options.Title;
            Width = options.Width;
            Height = options.Height;
            MinimumSize = new Size(520, 380);
            StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.Dpi;
            BackColor = Color.FromArgb(249, 250, 251);
            Icon = SystemIcons.Application;
            if (options.Opacity < 100) Opacity = options.Opacity / 100.0;
            try
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            }
            catch
            {
            }

            view = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(249, 250, 251),
            };
            Controls.Add(view);

            // The token hop loads the ordinary shell for a moment; cover it
            // with the same quiet loading state the conversation page paints.
            splash = new Panel { Dock = DockStyle.Fill, BackColor = Color.FromArgb(249, 250, 251) };
            splashLabel = new Label
            {
                AutoSize = false,
                Dock = DockStyle.Fill,
                Text = "正在载入会话…",
                TextAlign = ContentAlignment.MiddleCenter,
                ForeColor = Color.FromArgb(107, 114, 128),
                BackColor = Color.Transparent,
                Font = new Font("Microsoft YaHei UI", 11f, FontStyle.Regular),
            };
            splashBar = new ProgressBar
            {
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 26,
                Anchor = AnchorStyles.None,
                Size = new Size(200, 6),
            };
            var splashLayout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
            splashLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            splashLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 40f));
            splashLayout.RowStyles.Add(new RowStyle(SizeType.Absolute, 26f));
            splashLayout.RowStyles.Add(new RowStyle(SizeType.Percent, 50f));
            splashLayout.Controls.Add(splashLabel, 0, 1);
            splashLayout.Controls.Add(splashBar, 0, 2);
            splash.Controls.Add(splashLayout);
            Controls.Add(splash);
            splash.BringToFront();
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Stage("启动中…");
            // Both checks run on their own threads. A window whose UI thread is
            // the thing that is stuck can neither close itself nor show an error,
            // and Windows would keep a frozen frame in Alt+Tab until Explorer
            // restarts — ending the process is the only way out.
            StartStartupWatchdog();
            StartLivenessWatch();
            // WinForms here runs at 96 DPI while the window is per-monitor
            // aware, so the requested size is DIPs: grow it to device pixels or
            // the window would look shrunken on a scaled display.
            try
            {
                using (var graphics = CreateGraphics())
                {
                    var scale = graphics.DpiX / 96f;
                    if (scale > 1.05f)
                    {
                        Width = (int)Math.Round(options.Width * scale);
                        Height = (int)Math.Round(options.Height * scale);
                        MinimumSize = new Size((int)Math.Round(520 * scale), (int)Math.Round(380 * scale));
                        // The form was centred at its pre-scale size; growing it
                        // would push the window off the bottom-right corner.
                        var area = Screen.FromControl(this).WorkingArea;
                        Width = Math.Min(Width, area.Width);
                        Height = Math.Min(Height, area.Height);
                        Location = new Point(
                            area.X + Math.Max(0, (area.Width - Width) / 2),
                            area.Y + Math.Max(0, (area.Height - Height) / 2));
                    }
                }
            }
            catch
            {
            }

            try
            {
                explicitDataDir = options.DataDir;
                var dataFolder = PrepareDataFolder();
                var environment = await CoreWebView2Environment.CreateAsync(null, dataFolder);
                await view.EnsureCoreWebView2Async(environment);

                var core = view.CoreWebView2;
                // A detached conversation must not chime on its own: notification
                // and error sounds belong to the main window, if anywhere.
                core.IsMuted = options.Mute;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreBrowserAcceleratorKeysEnabled = true;
                core.Settings.IsZoomControlEnabled = false;
                core.DocumentTitleChanged += (sender, args) =>
                {
                    var title = TitleSuffix.Replace(core.DocumentTitle ?? "", "").Trim();
                    if (title.Length > 0 && title != "DeepSeek Harness") Text = title;
                };

                core.NavigationCompleted += OnNavigationCompleted;
                core.WebMessageReceived += OnWebMessage;
                core.ProcessFailed += OnProcessFailed;
                StartParentWatch();
                StartAppearanceWatch(core);
                Stage("载入会话…");
                // One loading state only: this splash (label + marquee) stays on
                // top of the view until the conversation page reports that it is
                // ready, so neither the token hop nor the page's own boot flashes.
                splashTimer = new Timer { Interval = 10000 };
                splashTimer.Tick += (sender, args) => Reveal();
                splashTimer.Start();
                core.Navigate(options.BootUrl);
            }
            catch (Exception error)
            {
                // The browser will not come up. Record the real exception and
                // show it, but leave the startup watchdog armed: it closes this
                // window on the startup deadline (ending the process if even
                // that is stuck) instead of leaving a dead window on screen.
                ShowStartupError(error);
                return;
            }
            startupDone.Set();
        }

        /**
         * A WebView2 start can hang (a profile lock, the runtime updater holding
         * a file, a loaded security product) and the loading state would then
         * stay on screen forever. Ask the window to close; if even that is not
         * processed, the process ends so Windows drops the frozen frame.
         */
        private void StartStartupWatchdog()
        {
            var timeout = Math.Max(5, Math.Min(120, options.StartupTimeoutSeconds));
            var watchdog = new Thread(() =>
            {
                if (startupDone.Wait(timeout * 1000)) return;
                try
                {
                    BeginInvoke(new Action(() =>
                    {
                        try { Close(); } catch { }
                    }));
                }
                catch
                {
                    // The handle is gone; the liveness probe owns this case.
                }
                if (startupDone.Wait(4000)) return;
                Program.HardExit(3);
            })
            {
                IsBackground = true,
                Name = "ove-startup-watchdog",
            };
            watchdog.Start();
        }

        /**
         * The last line of defence while the window is up: a probe posted every
         * few seconds must be answered by the UI thread. When it is not, nothing
         * on screen can close the window any more, so the process ends itself
         * before Windows turns it into a ghost window.
         */
        private void StartLivenessWatch()
        {
            var probe = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(3000);
                    if (IsDisposed) return;
                    var answered = new ManualResetEventSlim(false);
                    try
                    {
                        BeginInvoke(new Action(() => answered.Set()));
                    }
                    catch
                    {
                        answered.Dispose();
                        return;
                    }
                    var ok = answered.Wait(5000);
                    answered.Dispose();
                    if (!ok) Program.HardExit(4);
                }
            })
            {
                IsBackground = true,
                Name = "ove-liveness-watchdog",
            };
            probe.Start();
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            if (!args.IsSuccess)
            {
                // The host may still be starting (or the token already used):
                // one retry, then say so instead of showing a blank error page.
                if (!retried)
                {
                    retried = true;
                    Stage("无法连接本机服务，正在重试…");
                    var retry = new Timer { Interval = 1200 };
                    retry.Tick += (timerSender, timerArgs) =>
                    {
                        retry.Stop();
                        retry.Dispose();
                        try { view.CoreWebView2.Navigate(switched ? options.AppUrl : options.BootUrl); }
                        catch { ShowLoadFailure(); }
                    };
                    retry.Start();
                    return;
                }
                ShowLoadFailure();
                return;
            }
            if (switched || options.AppUrl.Length == 0) return;
            // The authenticated URL answered and minted the session cookie, so
            // the conversation page (sidebar-free) can be opened in place.
            switched = true;
            Stage("载入会话…");
            view.CoreWebView2.Navigate(options.AppUrl);
        }

        private void ShowLoadFailure(string message = "无法连接本机服务，请稍后重试")
        {
            try
            {
                if (splashTimer != null) { splashTimer.Stop(); }
            }
            catch { }
            try
            {
                splashLabel.Text = message;
                splashBar.Visible = false;
                splash.Visible = true;
                splash.BringToFront();
                Stage("加载失败");
            }
            catch { }
        }

        /** A plugin upgrade or a Host crash must not leave this window orphaned. */
        private void StartParentWatch()
        {
            if (options.ParentPid <= 0) return;
            var watch = new Timer { Interval = 1000 };
            watch.Tick += (sender, args) =>
            {
                if (Program.ProcessAlive(options.ParentPid)) return;
                watch.Stop();
                Close();
            };
            watch.Start();
        }

        /** The plugin page edits appearance once for every open window. */
        private void StartAppearanceWatch(CoreWebView2 core)
        {
            if (options.AppearanceFile.Length == 0) return;
            var watch = new Timer { Interval = 800 };
            var appliedOpacity = OptionsOpacity(options.Opacity);
            var appliedMute = options.Mute;
            watch.Tick += (sender, args) =>
            {
                string text;
                try
                {
                    if (!File.Exists(options.AppearanceFile)) return;
                    text = File.ReadAllText(options.AppearanceFile);
                }
                catch { return; }
                var opacityMatch = Regex.Match(text, "\"opacity\"\\s*:\\s*(\\d+)");
                var muteMatch = Regex.Match(text, "\"mute\"\\s*:\\s*(true|false)");
                if (opacityMatch.Success)
                {
                    int value;
                    if (int.TryParse(opacityMatch.Groups[1].Value, out value))
                    {
                        var next = OptionsOpacity(value);
                        if (Math.Abs(next - appliedOpacity) > 0.001)
                        {
                            appliedOpacity = next;
                            ApplyOpacity(next);
                        }
                    }
                }
                if (muteMatch.Success)
                {
                    var next = muteMatch.Groups[1].Value != "false";
                    if (next != appliedMute)
                    {
                        appliedMute = next;
                        try { core.IsMuted = next; } catch { }
                    }
                }
            };
            watch.Start();
        }

        private static double OptionsOpacity(int percent)
        {
            if (percent >= 100) return 1.0;
            if (percent < 30) return 1.0;
            return percent / 100.0;
        }

        private void ApplyOpacity(double value)
        {
            try { Opacity = value; } catch { }
        }

        private void OnProcessFailed(object sender, CoreWebView2ProcessFailedEventArgs args)
        {
            try
            {
                if (args.ProcessFailedKind == CoreWebView2ProcessFailedKind.BrowserProcessExited)
                {
                    Close();
                    return;
                }
                // A dead renderer must not leave an empty frame behind.
                var recover = new Timer { Interval = 800 };
                recover.Tick += (timerSender, timerArgs) =>
                {
                    recover.Stop();
                    recover.Dispose();
                    try { view.CoreWebView2.Reload(); } catch { Close(); }
                };
                recover.Start();
            }
            catch { }
        }

        private void ShowStartupError(Exception error)
        {
            // The real exception is the only thing that can be diagnosed later:
            // the window itself is about to be closed by the startup watchdog.
            var logPath = WriteStartupLog(error);
            var missingRuntime = MissingWebView2Runtime();
            Stage(missingRuntime ? "需要 WebView2 运行时" : "内置浏览器启动失败");
            try
            {
                splashLabel.Text = missingRuntime
                    ? "缺少 Microsoft Edge WebView2 运行时，请安装后重新打开窗口。"
                    : "内置浏览器启动失败：" + SummarizeError(error)
                        + Environment.NewLine + "详情见日志：" + logPath;
                splashBar.Visible = false;
                splash.Visible = true;
                splash.BringToFront();
            }
            catch { }
        }

        /**
         * Whether the WebView2 runtime is really absent. The old test matched the
         * word "WebView2" anywhere in the exception text, and the data-folder
         * probe reports its own path (…\dsh-ove-window\webview2): a plain
         * permission error was then announced as a missing runtime and sent the
         * user off to reinstall it. Ask the loader, which knows.
         */
        private static bool MissingWebView2Runtime()
        {
            try
            {
                var version = CoreWebView2Environment.GetAvailableBrowserVersionString();
                return string.IsNullOrEmpty(version);
            }
            catch
            {
                return true;
            }
        }

        /** First line of an exception, short enough for the loading label. */
        private static string SummarizeError(Exception error)
        {
            if (error == null) return "未知错误";
            var text = (error.Message ?? "").Trim();
            if (text.Length == 0) text = error.GetType().Name;
            var line = text.Split('\n')[0].Trim();
            return line.Length <= 160 ? line : line.Substring(0, 160) + "…";
        }

        /**
         * Append one startup failure to %LOCALAPPDATA%\dsh-ove-window\startup-error.log
         * and return its path for the error label.
         * @param error - the exception that stopped the embedded browser.
         * @returns the log path (also when writing failed, so the label can point at it).
         */
        private static string WriteStartupLog(Exception error)
        {
            var folder = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-ove-window");
            var path = Path.Combine(folder, "startup-error.log");
            try
            {
                Directory.CreateDirectory(folder);
                var text = new System.Text.StringBuilder();
                text.Append('[').Append(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")).Append("] ");
                text.Append(error == null ? "unknown startup error" : error.ToString());
                text.AppendLine();
                File.AppendAllText(path, text.ToString(), System.Text.Encoding.UTF8);
            }
            catch { }
            return path;
        }

        /** The conversation page says it finished mounting; lift the cover. */
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch { return; }
            if (message == "ove-ready")
            {
                Reveal();
                return;
            }
            // `ove-timeout` means the page gave up waiting. Lifting the cover
            // here used to reveal the app's welcome screen, which reads as a
            // window that silently opened the wrong conversation. Keep a clear
            // failure state instead; the Host's startup grace period closes a
            // window that never reports ready.
            if (message == "ove-timeout") ShowLoadFailure("无法加载会话，请稍后重试。");
        }

        private void Reveal()
        {
            if (revealed) return;
            revealed = true;
            try
            {
                if (splashTimer != null)
                {
                    splashTimer.Stop();
                    splashTimer.Dispose();
                    splashTimer = null;
                }
            }
            catch
            {
            }
            try { splash.Visible = false; } catch { }
        }

        private void Stage(string message)
        {
            try { Text = message; } catch { }
        }

        private static string PrepareDataFolder()
        {
            var candidates = new System.Collections.Generic.List<string>();
            // The Host passes a per-window profile and removes it afterwards:
            // using it first is what keeps windows (and their cookies) apart.
            if (explicitDataDir.Length > 0) candidates.Add(explicitDataDir);
            candidates.Add(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-ove-window",
                "webview2"));
            candidates.Add(Path.Combine(Path.GetTempPath(), "dsh-ove-window", "webview2"));

            var report = new System.Text.StringBuilder();
            foreach (var candidate in candidates)
            {
                try
                {
                    Directory.CreateDirectory(candidate);
                    var probe = Path.Combine(candidate, "write-test.txt");
                    File.WriteAllText(probe, "ok");
                    File.Delete(probe);
                    return candidate;
                }
                catch (Exception error)
                {
                    report.Append(candidate).Append(" => ").Append(error.GetType().Name).Append(": ").Append(error.Message).Append('\n');
                }
            }
            throw new IOException(report.ToString());
        }
    }
}
