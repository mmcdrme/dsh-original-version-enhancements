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
        public string Session = "";
        public string Title = "独立会话窗口";
        public int Width = 1100;
        public int Height = 800;
        public int Opacity = 100;
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
                    case "--session": options.Session = value; break;
                    case "--title": options.Title = value; break;
                    case "--width": int.TryParse(value, out options.Width); break;
                    case "--height": int.TryParse(value, out options.Height); break;
                    case "--opacity": int.TryParse(value, out options.Opacity); break;
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
        private static string explicitDataDir = "";

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

            view = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(249, 250, 251),
            };
            Controls.Add(view);
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
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.Settings.IsZoomControlEnabled = false;
            core.DocumentTitleChanged += (sender, args) =>
            {
                var title = TitleSuffix.Replace(core.DocumentTitle ?? "", "").Trim();
                if (title.Length > 0 && title != "DeepSeek Harness") Text = title;
            };

            // The window was opened for one conversation: leave a one-shot
            // cookie the client reads on boot, then let the normal app load.
            if (options.Session.Length > 0)
            {
                try
                {
                    var target = new Uri(options.BootUrl);
                    var cookie = core.CookieManager.CreateCookie("ove-window-session", options.Session, target.Host, "/");
                    cookie.IsSecure = target.Scheme == "https";
                    cookie.IsHttpOnly = false;
                    core.CookieManager.AddOrUpdateCookie(cookie);
                }
                catch
                {
                    // A failed cookie only costs the initial selection.
                }
            }

            Stage("载入会话…");
            core.Navigate(options.BootUrl);
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
