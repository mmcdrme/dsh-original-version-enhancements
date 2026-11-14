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
                }
            }
            if (options.BootUrl.Length == 0) throw new ArgumentException("缺少 --url 参数。");
            if (options.Width < 480) options.Width = 480;
            if (options.Height < 360) options.Height = 360;
            if (options.Opacity < 30) options.Opacity = 100;
            if (options.Opacity > 100) options.Opacity = 100;
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
            }
            catch (Exception error)
            {
                ShowStartupError(error);
                return;
            }

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

        private void ShowLoadFailure()
        {
            try
            {
                if (splashTimer != null) { splashTimer.Stop(); }
            }
            catch { }
            try
            {
                splashLabel.Text = "无法连接本机服务，请稍后重试";
                splashBar.Visible = false;
                splash.Visible = true;
                splash.BringToFront();
                Stage("连接失败");
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
            var message = error == null ? "" : (error.Message ?? "");
            var missingRuntime = message.IndexOf("WebView2 Runtime", StringComparison.OrdinalIgnoreCase) >= 0
                || message.IndexOf("WebView2", StringComparison.OrdinalIgnoreCase) >= 0;
            Stage(missingRuntime ? "需要 WebView2 运行时" : "内置浏览器启动失败");
            try
            {
                splashLabel.Text = missingRuntime
                    ? "缺少 Microsoft Edge WebView2 运行时，请安装后重试"
                    : "内置浏览器启动失败，请查看日志后重试";
                splashBar.Visible = false;
                splash.Visible = true;
                splash.BringToFront();
            }
            catch { }
            if (!missingRuntime) return;
            MessageBox.Show(
                "独立窗口需要 Microsoft Edge WebView2 运行时。\n请从 Microsoft 官网安装“WebView2 Runtime”后重新打开窗口。",
                "独立窗口",
                MessageBoxButtons.OK,
                MessageBoxIcon.Information);
        }

        /** The conversation page says it finished mounting; lift the cover. */
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch { return; }
            // `ove-timeout` means the page gave up waiting: still lift the cover
            // so the user sees what is there instead of a marquee forever.
            if (message == "ove-ready" || message == "ove-timeout") Reveal();
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
