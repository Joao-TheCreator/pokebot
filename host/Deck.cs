// PokeBot Deck: uma janela com 3 colunas -> ferramentas (esquerda) | 4 contas do PokeIdle | monitor (direita).
// As contas rodam num WebView2 so (motor do Edge, o mesmo dos decks da comunidade, que passa na Cloudflare), cada
// uma num perfil proprio (login separado), com uma porta de depuracao local (9300) para o motor do PokeBot.
// O host mede RAM/CPU de cada conta e manda para o monitor. Tudo roda neste PC.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

class Deck : Form
{
    // nomes das 4 contas: config/contas.json (so neste PC) ou o modelo config/contas.example.json
    static readonly string[] Accs = LerContas();
    static string[] LerContas()
    {
        string cfg = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", "config"));
        foreach (var f in new[] { "contas.json", "contas.example.json" })
        {
            try
            {
                var m = System.Text.RegularExpressions.Regex.Match(File.ReadAllText(Path.Combine(cfg, f)), "\"contas\"\\s*:\\s*\\[([^\\]]*)\\]");
                if (!m.Success) continue;
                var nomes = new List<string>();
                foreach (System.Text.RegularExpressions.Match s in System.Text.RegularExpressions.Regex.Matches(m.Groups[1].Value, "\"([^\"]+)\"")) nomes.Add(s.Groups[1].Value);
                if (nomes.Count >= 4) return nomes.GetRange(0, 4).ToArray();
            }
            catch { }
        }
        return new[] { "conta1", "conta2", "conta3", "conta4" };
    }
    static readonly int[] Ports = { 9301, 9302, 9303, 9304 };
    static readonly Color[] Cores = { Color.FromArgb(225, 80, 90), Color.FromArgb(232, 150, 60), Color.FromArgb(70, 190, 120), Color.FromArgb(90, 140, 240) };
    // moldura (desenhada pelo shell HTML por tras das contas): trilho de contas, barra do topo e painel da conta
    const int RailW = 64, TopH = 46, PanelW = 360, HeadH = 22, Gap = 6;
    // O jogo so usa o layout de 3 colunas (tudo cabe, sem rolagem) com pelo menos ~1150 px CSS de largura
    // (medido: 1100 empilha, 1150 cabe); o zoom nunca deixa a conta ficar mais estreita que isso.
    const double GameW = 1150;
    double zoomPref = 1.0;
    const string Flags = "--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows";
    static readonly Color Bg = Color.FromArgb(13, 12, 20), Bar = Color.FromArgb(24, 22, 36);

    readonly string root;
    readonly Panel[] boxes = new Panel[4];
    readonly Label[] heads = new Label[4];
    readonly WebView2[] views = new WebView2[4];
    readonly WebView2 shell = new WebView2();
    readonly int[] browserPid = new int[4];
    int panelPid;
    int focus = 0;          // conta selecionada (a "principal")
    int telas = 5;          // 1, 2, 3 ou 4 contas visiveis ao mesmo tempo; 5 = "1+3" (uma grande e 3 pequenas)
    bool cheia = false;     // tela cheia: so as contas, sem moldura
    bool painel = true;     // painel da conta (direita)
    readonly bool[] visivel = new bool[4];
    Process server;
    System.Threading.Timer metricsTimer;

    Deck(string root)
    {
        this.root = root;
        Text = "PokeBot";
        Size = new Size(1680, 980);
        MinimumSize = new Size(1100, 700);
        BackColor = Bg;
        StartPosition = FormStartPosition.CenterScreen;
        WindowState = FormWindowState.Maximized;
        KeyPreview = true;
        try { Icon = new Icon(Path.Combine(root, "host", "pokebot.ico")); } catch { }
        tray = new NotifyIcon { Icon = Icon ?? SystemIcons.Application, Text = "PokeBot", Visible = true };
        tray.BalloonTipClicked += (s, e) => AbrirDoAviso();
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) AbrirDoAviso(); };

        shell.DefaultBackgroundColor = Bg;
        for (int i = 0; i < 4; i++)
        {
            int k = i;
            boxes[i] = new Panel { BackColor = Bar };
            heads[i] = new Label
            {
                Dock = DockStyle.Top, Height = HeadH, ForeColor = Color.FromArgb(220, 216, 235), BackColor = Bar,
                TextAlign = ContentAlignment.MiddleLeft, Cursor = Cursors.Hand, Font = new Font("Segoe UI Semibold", 8.5f)
            };
            heads[i].MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) Select(k); };
            heads[i].MouseDoubleClick += (s, e) => { Select(k); telas = 1; DoLayout(); };
            var cm = new ContextMenuStrip();
            cm.Items.Add("Ver só esta conta", null, (s, e) => { Select(k); telas = 1; DoLayout(); });
            cm.Items.Add("Voltar ao jogo", null, (s, e) => Home(k));
            cm.Items.Add("Voltar (página anterior)", null, (s, e) => { var c = views[k].CoreWebView2; if (c != null && c.CanGoBack) c.GoBack(); });
            cm.Items.Add("Recarregar", null, (s, e) => { var c = views[k].CoreWebView2; if (c != null) c.Reload(); });
            heads[i].ContextMenuStrip = cm;
            views[i] = new WebView2 { Dock = DockStyle.Fill, DefaultBackgroundColor = Bg };
            boxes[i].Controls.Add(views[i]);
            boxes[i].Controls.Add(heads[i]);
            Controls.Add(boxes[i]);
        }
        Controls.Add(shell); // por ultimo = atras de tudo
        Resize += (s, e) => DoLayout();
        Load += async (s, e) => { DoLayout(); await Init(); };
        Shown += (s, e) => BeginInvoke((Action)(() => { WindowState = FormWindowState.Normal; WindowState = FormWindowState.Maximized; Activate(); }));
        FormClosed += (s, e) =>
        {
            if (metricsTimer != null) metricsTimer.Dispose();
            if (tray != null) { tray.Visible = false; tray.Dispose(); }
            try { if (server != null && !server.HasExited) server.Kill(); } catch { }
        };
    }

    // atalhos (funcionam mesmo com o foco no jogo, pois o WebView2 repassa as teclas nao usadas)
    protected override bool ProcessCmdKey(ref Message msg, Keys k)
    {
        if (k == (Keys.Control | Keys.D0)) { telas = 4; DoLayout(); return true; }
        for (int i = 0; i < 4; i++) if (k == (Keys.Control | (Keys.D1 + i))) { Select(i); telas = 1; DoLayout(); return true; }
        if (k == Keys.F11) { cheia = !cheia; DoLayout(); return true; }
        if (k == Keys.Escape && cheia) { cheia = false; DoLayout(); return true; }
        if (k == Keys.F3) { painel = !painel; DoLayout(); return true; }
        if (k == Keys.F5 && shell.CoreWebView2 != null) { shell.CoreWebView2.Reload(); return true; }
        if (k == (Keys.Control | Keys.Shift | Keys.Oemplus)) { zoomPref = Math.Min(1.0, zoomPref + 0.05); DoLayout(); return true; }
        if (k == (Keys.Control | Keys.Shift | Keys.OemMinus)) { zoomPref = Math.Max(0.3, Math.Min(zoomPref, CurrentZoom()) - 0.05); DoLayout(); return true; }
        return base.ProcessCmdKey(ref msg, k);
    }

    // ---------------- layout ----------------
    void Select(int idx)
    {
        if (idx < 0 || idx > 3) return;
        focus = idx;
        DoLayout();
        views[focus].Focus();
        if (views[focus].CoreWebView2 != null) views[focus].CoreWebView2.ExecuteScriptAsync("window.focus()");
    }

    // ordem de exibicao: a selecionada primeiro, depois as seguintes
    int[] Ordem() { var o = new int[4]; for (int i = 0; i < 4; i++) o[i] = (focus + i) % 4; return o; }

    void DoLayout()
    {
        int w = ClientSize.Width, h = ClientSize.Height;
        shell.SetBounds(0, 0, w, h);
        int x0 = cheia ? 0 : RailW, y0 = cheia ? 0 : TopH, x1 = w - (cheia || !painel ? 0 : PanelW);
        int g = cheia ? 0 : Gap;
        Rectangle area = new Rectangle(x0 + g, y0 + g, Math.Max(200, x1 - x0 - 2 * g), Math.Max(200, h - y0 - 2 * g));
        var rects = new Rectangle[4];
        bool umMais3 = telas == 5; // "1+3": a selecionada grande e as outras 3 numa coluna estreita a direita
        int n = umMais3 ? 4 : Math.Max(1, Math.Min(4, telas));
        int hw = (area.Width - g) / 2, hh = (area.Height - g) / 2;
        if (umMais3)
        {
            int bw = (int)(area.Width * 0.76), sw = area.Width - bw - g, sh = (area.Height - 2 * g) / 3;
            rects[0] = new Rectangle(area.X, area.Y, bw, area.Height);
            for (int j = 1; j < 4; j++)
                rects[j] = new Rectangle(area.X + bw + g, area.Y + (j - 1) * (sh + g), sw, j == 3 ? area.Height - 2 * (sh + g) : sh);
        }
        else if (n == 1) rects[0] = area;
        else if (n == 2) { rects[0] = new Rectangle(area.X, area.Y, hw, area.Height); rects[1] = new Rectangle(area.X + hw + g, area.Y, area.Width - hw - g, area.Height); }
        else if (n == 3)
        {
            int bw = (int)(area.Width * 0.6);
            rects[0] = new Rectangle(area.X, area.Y, bw, area.Height);
            rects[1] = new Rectangle(area.X + bw + g, area.Y, area.Width - bw - g, hh);
            rects[2] = new Rectangle(area.X + bw + g, area.Y + hh + g, area.Width - bw - g, area.Height - hh - g);
        }
        else for (int i = 0; i < 4; i++) rects[i] = new Rectangle(area.X + (i % 2) * (hw + g), area.Y + (i / 2) * (hh + g), i % 2 == 0 ? hw : area.Width - hw - g, i / 2 == 0 ? hh : area.Height - hh - g);
        int[] ordem = n == 4 && !umMais3 ? new[] { 0, 1, 2, 3 } : Ordem();
        for (int j = 0; j < 4; j++)
        {
            int i = ordem[j];
            visivel[i] = j < n;
            // as contas fora da tela ficam atras da principal, do mesmo tamanho: continuam jogando
            Rectangle r = j < n ? rects[j] : rects[0];
            boxes[i].SetBounds(r.X, r.Y, r.Width, r.Height);
            double z = Math.Min(zoomPref, r.Width / GameW);
            if (z < 0.3) z = 0.3;
            if (views[i].CoreWebView2 != null) { views[i].ZoomFactor = z; FitZoom(i); }
            heads[i].Text = "  ●  C" + (i + 1) + "  " + Accs[i] + (i == focus ? "      (selecionada — teclado e mouse aqui)" : "");
            heads[i].ForeColor = Cores[i];
            heads[i].BackColor = i == focus ? Color.FromArgb(40, 34, 64) : Bar;
        }
        // z-order: escondidas no fundo, depois as visiveis, a selecionada por cima
        for (int j = 3; j >= 0; j--) { int i = ordem[j]; if (!visivel[i]) boxes[i].SendToBack(); }
        for (int j = n - 1; j >= 0; j--) boxes[ordem[j]].BringToFront();
        boxes[focus].BringToFront();
        shell.SendToBack();
        PostEstado();
    }

    void PostEstado()
    {
        if (shell.CoreWebView2 == null) return;
        string json = "{\"tipo\":\"estado\",\"sel\":" + focus + ",\"telas\":" + telas + ",\"cheia\":" + (cheia ? "true" : "false") +
            ",\"painel\":" + (painel ? "true" : "false") + ",\"zoom\":" + CurrentZoom().ToString("0.00", CultureInfo.InvariantCulture) + "}";
        try { shell.CoreWebView2.PostWebMessageAsString(json); } catch { }
    }

    // Ajusta o zoom ate o jogo caber inteiro na celula (sem barra de rolagem).
    readonly int[] fitGen = new int[4];
    async void FitZoom(int i)
    {
        int gen = ++fitGen[i];
        var c = views[i].CoreWebView2;
        if (c == null) return;
        try
        {
            for (int pass = 0; pass < 4; pass++)
            {
                await Task.Delay(pass == 0 ? 300 : 500);
                if (gen != fitGen[i]) return;
                string r = await c.ExecuteScriptAsync("(function(){var e=document.scrollingElement||document.documentElement;return [innerWidth,innerHeight,e.scrollWidth,e.scrollHeight].join(',')})()");
                string[] p = r.Trim('"').Split(',');
                if (p.Length < 4) return;
                double iw = double.Parse(p[0], CultureInfo.InvariantCulture), ih = double.Parse(p[1], CultureInfo.InvariantCulture);
                double sw = double.Parse(p[2], CultureInfo.InvariantCulture), sh = double.Parse(p[3], CultureInfo.InvariantCulture);
                double k = Math.Min(iw / Math.Max(sw, 1), ih / Math.Max(sh, 1));
                if (k >= 0.995) return;
                double z = Math.Max(0.4, views[i].ZoomFactor * k * 0.99);
                if (Math.Abs(z - views[i].ZoomFactor) < 0.01) return;
                views[i].ZoomFactor = z;
            }
        }
        catch { }
    }

    double CurrentZoom() { var c = views[focus]; return c.CoreWebView2 != null ? c.ZoomFactor : zoomPref; }

    void Home(int k) { var c = views[k].CoreWebView2; if (c != null) c.Navigate("https://pokeidle.io"); }

    // ---------------- servidor local ----------------
    static bool PortOpen(int port)
    {
        try { using (var c = new TcpClient()) { return c.ConnectAsync("127.0.0.1", port).Wait(300) && c.Connected; } }
        catch { return false; }
    }

    async Task EnsureServer()
    {
        if (PortOpen(8787)) return;
        var psi = new ProcessStartInfo("node", "server.js")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        psi.EnvironmentVariables["POKEBOT_MODE"] = "app";
        try { server = Process.Start(psi); }
        catch (Exception ex) { MessageBox.Show("Não consegui iniciar o servidor (node server.js): " + ex.Message, "PokeBot"); return; }
        var log = File.AppendText(Path.Combine(root, "data", "servidor.log"));
        log.AutoFlush = true;
        server.OutputDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine(e.Data); };
        server.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (log) log.WriteLine("ERRO " + e.Data); };
        server.BeginOutputReadLine(); server.BeginErrorReadLine();
        for (int i = 0; i < 40 && !PortOpen(8787); i++) await Task.Delay(250);
    }

    // Um navegador so (um processo principal, uma GPU, uma rede) com um perfil por conta: cada perfil tem
    // seus proprios cookies e login. O motor conecta na porta 9300 e acha cada conta pela marca window.__pokebotAcc.
    const int SharedPort = 9300;
    CoreWebView2Environment env;

    async Task Init()
    {
        string data = Path.Combine(root, "profiles", "wv2");
        var opt = new CoreWebView2EnvironmentOptions("--remote-debugging-port=" + SharedPort + " " + Flags);
        env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(data, "_deck"), opt);
        for (int i = 0; i < 4; i++)
        {
            var co = env.CreateCoreWebView2ControllerOptions();
            co.ProfileName = Accs[i];
            await views[i].EnsureCoreWebView2Async(env, co);
            views[i].CoreWebView2.Settings.IsStatusBarEnabled = false;
            await views[i].CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(
                "Object.defineProperty(window,'__pokebotAcc',{value:'" + Accs[i] + "'})");
            browserPid[i] = (int)views[i].CoreWebView2.BrowserProcessId;
            int k = i;
            views[i].CoreWebView2.NavigationCompleted += (s, e) => FitZoom(k);
            views[i].GotFocus += (s, e) => { if (focus != k) { focus = k; DoLayout(); } };
            views[i].CoreWebView2.Navigate("https://pokeidle.io");
        }
        DoLayout();
        await EnsureServer();
        var pco = env.CreateCoreWebView2ControllerOptions();
        pco.ProfileName = "_painel";
        await shell.EnsureCoreWebView2Async(env, pco);
        shell.CoreWebView2.Settings.IsStatusBarEnabled = false;
        shell.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        shell.CoreWebView2.WebMessageReceived += OnPanelMessage;
        shell.CoreWebView2.NavigationCompleted += (s, e) => PostEstado();
        try { shell.CoreWebView2.MemoryUsageTargetLevel = CoreWebView2MemoryUsageTargetLevel.Low; } catch { }
        panelPid = (int)shell.CoreWebView2.BrowserProcessId;
        shell.CoreWebView2.Navigate("http://127.0.0.1:8787/shell.html");
        ApplyMemoryLevels();
        var mapTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        mapTimer.Tick += async (s, e) => await RefreshProcMap();
        mapTimer.Start();
        await RefreshProcMap();
        metricsTimer = new System.Threading.Timer(_ => SampleMetrics(), null, 1000, 3000);
    }

    // ---------------- qual processo e de qual conta ----------------
    // Com um navegador so, todos os processos sao filhos do mesmo processo principal. Os de pagina (renderer)
    // sao atribuidos pela conta dona do frame principal; o resto (principal, GPU, rede...) e "compartilhado".
    volatile Dictionary<int, int> procAcc = new Dictionary<int, int>(); // pid -> conta (0-3) ou 4 = painel
    async Task RefreshProcMap()
    {
        if (env == null) return;
        try
        {
            var main = new Dictionary<ulong, int>();
            for (int i = 0; i < 4; i++) if (views[i].CoreWebView2 != null) main[views[i].CoreWebView2.FrameId] = i;
            if (shell.CoreWebView2 != null) main[shell.CoreWebView2.FrameId] = 4;
            var map = new Dictionary<int, int>();
            foreach (var pi in await env.GetProcessExtendedInfosAsync())
                foreach (var f in pi.AssociatedFrameInfos)
                {
                    var top = f;
                    while (top.ParentFrameInfo != null) top = top.ParentFrameInfo;
                    int acc;
                    if (main.TryGetValue(top.FrameId, out acc)) { map[pi.ProcessInfo.ProcessId] = acc; break; }
                }
            procAcc = map;
        }
        catch { }
    }

    // ---------------- economia de memoria ----------------
    // Conta que nao esta na tela -> MemoryUsageTargetLevel.Low (descarta caches; NAO suspende o jogo).
    string memSig = "";
    void ApplyMemoryLevels()
    {
        string sig = string.Join(",", visivel) + focus;
        if (memSig == sig) return;
        memSig = sig;
        for (int i = 0; i < 4; i++)
        {
            var c = views[i].CoreWebView2;
            if (c == null) continue;
            try { c.MemoryUsageTargetLevel = visivel[i] ? CoreWebView2MemoryUsageTargetLevel.Normal : CoreWebView2MemoryUsageTargetLevel.Low; } catch { }
        }
    }

    // comandos do shell: "select:2", "telas:3", "cheia", "painel", "home:1", "reload:3", "back:0", "reloadall", "zoom+", "zoom-"
    void OnPanelMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string m;
        try { m = e.TryGetWebMessageAsString(); } catch { return; }
        if (m == null) return;
        string[] p = m.Split(':');
        int k = -1;
        if (p.Length > 1) int.TryParse(p[1], out k);
        bool ok = k >= 0 && k < 4;
        switch (p[0])
        {
            case "select": if (ok) Select(k); break;
            case "telas": if (k >= 1 && k <= 5) { telas = k; DoLayout(); } break;
            case "cheia": cheia = !cheia; DoLayout(); break;
            case "painel": painel = !painel; DoLayout(); break;
            case "home": if (ok) Home(k); break;
            case "reload": if (ok && views[k].CoreWebView2 != null) views[k].CoreWebView2.Reload(); break;
            case "back": if (ok && views[k].CoreWebView2 != null && views[k].CoreWebView2.CanGoBack) views[k].CoreWebView2.GoBack(); break;
            case "reloadall": foreach (var v in views) if (v.CoreWebView2 != null) v.CoreWebView2.Reload(); break;
            case "zoom+": zoomPref = Math.Min(1.0, zoomPref + 0.05); DoLayout(); break;
            case "zoom-": zoomPref = Math.Max(0.3, Math.Min(zoomPref, CurrentZoom()) - 0.05); DoLayout(); break;
            case "estado": PostEstado(); break;
        }
    }

    // ---------------- RAM e CPU ----------------
    [StructLayout(LayoutKind.Sequential)]
    class MEMORYSTATUSEX
    {
        public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
        public uint dwMemoryLoad; public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }
    [DllImport("kernel32.dll")] static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX m);

    PerformanceCounter cpuTotal;
    readonly Dictionary<string, long> lastCpu = new Dictionary<string, long>(); // grupo -> tempo de CPU (100 ns)
    DateTime lastAt = DateTime.MinValue;
    int sampling;

    void SampleMetrics()
    {
        if (Interlocked.Exchange(ref sampling, 1) == 1) return;
        try
        {
            if (cpuTotal == null) { cpuTotal = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpuTotal.NextValue(); }
            var procs = new Dictionary<int, long[]>(); // pid -> [pai, memoria privada, cpu]
            using (var q = new ManagementObjectSearcher("SELECT ProcessId,ParentProcessId,PrivatePageCount,KernelModeTime,UserModeTime FROM Win32_Process WHERE Name='msedgewebview2.exe' OR Name='node.exe' OR Name='PokeBot.exe'"))
                foreach (ManagementObject o in q.Get())
                    procs[(int)(uint)o["ProcessId"]] = new long[] {
                        (long)(uint)o["ParentProcessId"], (long)(ulong)o["PrivatePageCount"],
                        (long)(ulong)o["KernelModeTime"] + (long)(ulong)o["UserModeTime"] };

            var now = DateTime.UtcNow;
            double wall = lastAt == DateTime.MinValue ? 0 : (now - lastAt).TotalMilliseconds * 10000.0 * Environment.ProcessorCount;
            lastAt = now;
            // contas: so os processos de pagina de cada conta. app: painel + navegador compartilhado (principal,
            // GPU, rede...) + servidor + este host.
            var accMem = new long[4]; var accCpu = new long[4]; var accN = new int[4];
            long am = 0, ac = 0; int an = 0;
            var map = procAcc;
            foreach (int pid in TreeSet(procs, browserPid[0]))
            {
                int acc;
                if (map.TryGetValue(pid, out acc) && acc < 4) { accMem[acc] += procs[pid][1]; accCpu[acc] += procs[pid][2]; accN[acc]++; }
                else { am += procs[pid][1]; ac += procs[pid][2]; an++; }
            }
            var sb = new StringBuilder("{\"contas\":[");
            for (int i = 0; i < 4; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append("{\"conta\":\"").Append(Accs[i]).Append("\",\"ramMB\":").Append(Mb(accMem[i]))
                  .Append(",\"cpu\":").Append(Pct("c" + i, accCpu[i], wall)).Append(",\"processos\":").Append(accN[i]).Append('}');
            }
            int self = Process.GetCurrentProcess().Id;
            foreach (var kv in procs)
                if (kv.Key == self || (server != null && kv.Key == server.Id)) { am += kv.Value[1]; ac += kv.Value[2]; an++; }
            var ms = new MEMORYSTATUSEX();
            GlobalMemoryStatusEx(ms);
            sb.Append("],\"app\":{\"ramMB\":").Append(Mb(am)).Append(",\"cpu\":").Append(Pct("app", ac, wall)).Append(",\"processos\":").Append(an).Append('}');
            sb.Append(",\"sistema\":{\"cpu\":").Append(cpuTotal.NextValue().ToString("0.0", CultureInfo.InvariantCulture))
              .Append(",\"ramUsadaMB\":").Append((ms.ullTotalPhys - ms.ullAvailPhys) / 1048576)
              .Append(",\"ramTotalMB\":").Append(ms.ullTotalPhys / 1048576)
              .Append(",\"nucleos\":").Append(Environment.ProcessorCount)
              .Append("},\"foco\":").Append(focus).Append(",\"visiveis\":[").Append(string.Join(",", Array.ConvertAll(visivel, v => v ? "1" : "0"))).Append("]").Append(",\"t\":").Append((long)(now - new DateTime(1970, 1, 1)).TotalMilliseconds).Append('}');
            string json = sb.ToString();
            BeginInvoke((Action)(() => { ApplyMemoryLevels(); if (shell.CoreWebView2 != null) shell.CoreWebView2.PostWebMessageAsString(json); }));
            try
            {
                string resp;
                using (var wc = new WebClient()) { wc.Encoding = Encoding.UTF8; wc.Headers[HttpRequestHeader.ContentType] = "application/json"; resp = wc.UploadString("http://127.0.0.1:8787/metrics", json); }
                MostrarAvisos(resp);
            }
            catch { }
        }
        catch { }
        finally { Interlocked.Exchange(ref sampling, 0); }
    }

    // ---------------- avisos do Windows ----------------
    // O servidor devolve {ok,result:{notificacoes:[{acc,idx,titulo,texto}]}} no POST de metrics.
    NotifyIcon tray;
    int avisoIdx = -1; // conta do ultimo aviso: clicar no balao abre ela
    void MostrarAvisos(string resp)
    {
        var js = new System.Web.Script.Serialization.JavaScriptSerializer();
        var root = js.DeserializeObject(resp) as Dictionary<string, object>;
        if (root == null || !root.ContainsKey("result")) return;
        var result = root["result"] as Dictionary<string, object>;
        if (result == null || !result.ContainsKey("notificacoes")) return;
        var lista = result["notificacoes"] as object[];
        if (lista == null || lista.Length == 0) return;
        // varios avisos de uma vez viram um balao so (o Windows mostra um por vez)
        string titulo = "PokeBot", texto = ""; int idx = -1;
        foreach (var o in lista)
        {
            var n = o as Dictionary<string, object>;
            if (n == null) continue;
            if (idx < 0 && n.ContainsKey("idx")) idx = Convert.ToInt32(n["idx"]);
            if (lista.Length == 1) { titulo = Convert.ToString(n.ContainsKey("titulo") ? n["titulo"] : "PokeBot"); texto = Convert.ToString(n.ContainsKey("texto") ? n["texto"] : ""); }
            else texto += (texto.Length > 0 ? "\n" : "") + "• " + Convert.ToString(n.ContainsKey("acc") ? n["acc"] : "") + ": " + Convert.ToString(n.ContainsKey("texto") ? n["texto"] : "");
        }
        if (lista.Length > 1) titulo = "PokeBot: " + lista.Length + " avisos de hunt";
        if (texto.Length > 250) texto = texto.Substring(0, 247) + "...";
        BeginInvoke((Action)(() => { avisoIdx = idx; tray.ShowBalloonTip(10000, titulo, texto.Length > 0 ? texto : " ", ToolTipIcon.Info); }));
    }

    void AbrirDoAviso()
    {
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Maximized;
        Activate();
        if (avisoIdx >= 0 && avisoIdx < 4) Select(avisoIdx);
        if (!painel) { painel = true; DoLayout(); }
    }

    // o processo e todos os descendentes dele
    static HashSet<int> TreeSet(Dictionary<int, long[]> procs, int rootPid)
    {
        var set = new HashSet<int>();
        if (rootPid <= 0 || !procs.ContainsKey(rootPid)) return set;
        set.Add(rootPid);
        bool grew = true;
        while (grew)
        {
            grew = false;
            foreach (var kv in procs) if (!set.Contains(kv.Key) && set.Contains((int)kv.Value[0])) { set.Add(kv.Key); grew = true; }
        }
        return set;
    }

    static long Mb(long bytes) { return bytes / 1048576; }

    string Pct(string key, long cpu, double wall)
    {
        long prev;
        double v = 0;
        if (wall > 0 && lastCpu.TryGetValue(key, out prev)) v = Math.Max(0, (cpu - prev) * 100.0 / wall);
        lastCpu[key] = cpu;
        return v.ToString("0.0", CultureInfo.InvariantCulture);
    }

    [STAThread]
    static void Main()
    {
        // host\bin\PokeBot.exe -> pasta do projeto = dois niveis acima
        string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", ".."));
        Directory.CreateDirectory(Path.Combine(root, "data"));
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Deck(root));
    }
}
