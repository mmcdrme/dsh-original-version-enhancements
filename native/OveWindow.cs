// Independent conversation window for the DSH desktop client.
//
// The Desktop shell gives plugins no way to create a native window, so this
// small WinForms + WebView2 host is started by the plugin's Host half and is
// completely independent of the main window: it has its own taskbar entry, its
// own minimise/restore, and keeps running while the main window is minimised.
//
// It opens the Host's authenticated URL (which mints the browser cookie) and
// plants a one-shot `ove-window-session` cookie first, so the web client booting
// inside selects the conversation the window was opened for. The page is the
// ordinary client, so the sidebar keeps working here.

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
    }

    internal static class Program
    {
        // Per-monitor V2 keeps WebView2 on the device pixel grid; without it
        // Windows bitmap-scales the whole window and text turns blurry.
        [DllImport("user32.dll")]
        internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);

        [DllImport("user32.dll")]
        internal static extern bool SetProcessDPIAware();


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
                Stage("WebView2 启动失败: " + error.Message);
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
            if (switched || options.AppUrl.Length == 0) return;
            // The authenticated URL answered and minted the session cookie, so
            // the conversation page (sidebar-free) can be opened in place.
            switched = true;
            Stage("载入会话…");
            view.CoreWebView2.Navigate(options.AppUrl);
        }

        /** The conversation page says it finished mounting; lift the cover. */
        private void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs args)
        {
            string message;
            try { message = args.TryGetWebMessageAsString(); }
            catch { return; }
            if (message == "ove-ready") Reveal();
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
            candidates.Add(Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "dsh-ove-window",
                "webview2"));
            if (explicitDataDir.Length > 0) candidates.Add(explicitDataDir);
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
