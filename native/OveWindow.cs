// Independent conversation window for the DSH desktop client.
//
// The Desktop shell gives plugins no way to create a native window, so this
// small WinForms + WebView2 host is started by the plugin's Host half and is
// completely independent of the main window: it has its own taskbar entry, its
// own minimise/restore, and keeps running while the main window is minimised.
//
// It first opens the Host's authenticated URL (which mints the browser cookie),
// then switches to the plugin's embedded conversation page for one session.

using System;
using System.Drawing;
using System.IO;
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
        public string DataDir = "";
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
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
        private bool switched;

        public Window(Options options)
        {
            this.options = options;
            Text = options.Title;
            Width = options.Width;
            Height = options.Height;
            MinimumSize = new Size(480, 360);
            StartPosition = FormStartPosition.CenterScreen;
            BackColor = Color.FromArgb(249, 250, 251);
            Icon = SystemIcons.Application;
            // Layered-window alpha is only applied when the user asked for it;
            // a translucent window over a child Chromium surface is a trade the
            // settings page controls.
            if (options.Opacity < 100) Opacity = options.Opacity / 100.0;

            view = new WebView2
            {
                Dock = DockStyle.Fill,
                DefaultBackgroundColor = Color.FromArgb(249, 250, 251),
            };
            Controls.Add(view);
        }

        private static string ExplicitDataDir = "";

        private static string PrepareDataFolder()
        {
            var candidates = new System.Collections.Generic.List<string>();
            candidates.Add(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "dsh-ove-window", "webview2"));
            if (ExplicitDataDir.Length > 0) candidates.Add(ExplicitDataDir);
            candidates.Add(Path.Combine(Path.GetTempPath(), "dsh-ove-window", "webview2"));
            Exception last = null;
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
                    last = error;
                    report.Append(candidate).Append(" => ").Append(error.GetType().Name).Append(": ").Append(error.Message).Append("\n");
                }
            }
            throw new IOException(report.ToString());
        }

        private void Stage(string message)
        {
            try { Text = message; } catch { }
        }

        private static void Log(string message)
        {
            try
            {
                var folder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "dsh-ove-window");
                Directory.CreateDirectory(folder);
                File.AppendAllText(Path.Combine(folder, "window.log"), DateTime.Now.ToString("HH:mm:ss.fff") + " " + message + Environment.NewLine);
            }
            catch
            {
            }
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            Stage("启动中…");
            Log("load boot=" + options.BootUrl + " app=" + options.AppUrl);
            try
            {
                ExplicitDataDir = options.DataDir;
            var dataFolder = PrepareDataFolder();
                var environment = await CoreWebView2Environment.CreateAsync(null, dataFolder);
                await view.EnsureCoreWebView2Async(environment);
                Stage("WebView2 已就绪");
                Log("webview ready");
            }
            catch (Exception error)
            {
                Stage("WebView2 启动失败: " + error.Message);
                return;
            }

            var core = view.CoreWebView2;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreBrowserAcceleratorKeysEnabled = true;
            core.DocumentTitleChanged += (sender, args) =>
            {
                var title = TitleSuffix.Replace(core.DocumentTitle ?? "", "").Trim();
                if (title.Length > 0 && title != "DeepSeek Harness") Text = title;
            };
            core.NavigationCompleted += OnNavigationCompleted;
            core.NavigationStarting += (sender, args) => Log("starting " + args.Uri);
            Log("navigate boot");
            core.Navigate(options.BootUrl);
        }

        private void OnNavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args)
        {
            Stage("导航完成 success=" + args.IsSuccess + " status=" + args.HttpStatusCode + " error=" + args.WebErrorStatus + " " + view.CoreWebView2.Source);
            Log("completed success=" + args.IsSuccess + " status=" + args.HttpStatusCode + " error=" + args.WebErrorStatus + " url=" + view.CoreWebView2.Source);
            if (switched || options.AppUrl.Length == 0) return;
            // The authenticated URL answered and minted the session cookie, so
            // the embedded conversation page can now be opened in place.
            switched = true;
            Stage("打开会话页…");
            Log("navigate app " + options.AppUrl);
            view.CoreWebView2.Navigate(options.AppUrl);
        }
    }
}
