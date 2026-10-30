/**
 * 桌面启动程序与多尺寸图标构建脚本 (scripts/build-desktop-app.js)
 * 职责：
 * 1. 基于 common/ui/app-icon.svg 矢量几何规范，采用解析距离场（SDF）抗锯齿算法，
 *    零外部依赖生成包含 256/128/64/48/32/16 六种尺寸的 32 位真彩色 Windows 图标 (common/ui/icon.ico)；
 * 2. 调用 Windows 内置 .NET C# 编译器 (csc.exe) 编译纯桌面软件模式的 MAERS-QLS.exe：
 *    - 后台静默启动 Node 服务（无黑色命令行窗口）；
 *    - 通过 Chromium (Edge/Chrome) --app 模式以无地址栏独立软件窗口启动；
 *    - 监测独立窗口句柄 (HWND) 生命周期，关闭软件窗口时自动停止后台 Node 服务；
 *    - 重复双击时直接唤醒并置顶已打开的独立窗口，防止多开或端口顺延导致 IndexedDB 数据隔离。
 * 3. 自动同步复制一份 MAERS-QLS.exe 到系统桌面（若桌面目录存在），支持任意位置双击启动。
 * 用法：npm run build:exe 或 node scripts/build-desktop-app.js
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const ICON_PATH = path.join(ROOT, 'common', 'ui', 'icon.ico')
const EXE_PATH = path.join(ROOT, 'MAERS-QLS.exe')
const DESKTOP_DIR = path.join(os.homedir(), 'Desktop')
const DESKTOP_EXE_PATH = path.join(DESKTOP_DIR, 'MAERS-QLS.exe')

// ── 颜色与 SDF 几何工具（对应 common/ui/app-icon.svg 512x512 坐标系） ──

/** 解析十六进制颜色为 {r, g, b} */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

const COLORS = {
  bg: hexToRgb('#f3efe6'),
  stroke: hexToRgb('#43392f'),
  kraftDeco: hexToRgb('#e2d5be'),
  cardBg: hexToRgb('#fbf9f5'),
  title1: hexToRgb('#8c683a'),
  title2: hexToRgb('#d3c4ab'),
  gradStart: hexToRgb('#c49e6c'),
  gradEnd: hexToRgb('#8c683a'),
}

/** 圆角矩形有符号距离函数（返回值 < 0 表示在内部） */
function sdRoundedRect(px, py, x, y, w, h, r) {
  const cx = x + w * 0.5
  const cy = y + h * 0.5
  const hx = w * 0.5 - r
  const hy = h * 0.5 - r
  const dx = Math.abs(px - cx) - hx
  const dy = Math.abs(py - cy) - hy
  const outDist = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  const inDist = Math.min(Math.max(dx, dy), 0)
  return outDist + inDist - r
}

/** 点到线段的最短距离 */
function distToSegment(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const lenSq = vx * vx + vy * vy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / lenSq))
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))
}

/** 折角路径 (366,218)->(366,364)->(328,364) 的有符号距离 */
function sdCornerPath(px, py, halfStroke) {
  const d1 = distToSegment(px, py, 366, 218, 366, 364)
  const d2 = distToSegment(px, py, 366, 364, 328, 364)
  return Math.min(d1, d2) - halfStroke
}

/** 将 SDF 距离转换为像素级平滑覆盖率 alpha (0~1) */
function coverage(sd, pixelScale) {
  const d = sd / pixelScale
  return Math.max(0, Math.min(1, 0.5 - d))
}

/** Alpha 预乘混合（src 覆盖到 dst 上） */
function blend(dst, srcR, srcG, srcB, srcA) {
  if (srcA <= 0) return
  if (srcA >= 1 || dst.a === 0) {
    dst.r = srcR
    dst.g = srcG
    dst.b = srcB
    dst.a = srcA + dst.a * (1 - srcA)
    return
  }
  const outA = srcA + dst.a * (1 - srcA)
  dst.r = (srcR * srcA + dst.r * dst.a * (1 - srcA)) / outA
  dst.g = (srcG * srcA + dst.g * dst.a * (1 - srcA)) / outA
  dst.b = (srcB * srcA + dst.b * dst.a * (1 - srcA)) / outA
  dst.a = outA
}

/** 渲染带描边的圆角矩形 */
function paintStrokedRoundRect(dst, px, py, pixelScale, x, y, w, h, r, fillRgb, strokeRgb, strokeWidth) {
  const sdCenter = sdRoundedRect(px, py, x, y, w, h, r)
  const halfStroke = strokeWidth * 0.5
  const fillAlpha = coverage(sdCenter, pixelScale)
  if (fillAlpha > 0) {
    blend(dst, fillRgb.r, fillRgb.g, fillRgb.b, fillAlpha)
  }
  const sdStroke = Math.abs(sdCenter) - halfStroke
  const strokeAlpha = coverage(sdStroke, pixelScale)
  if (strokeAlpha > 0) {
    blend(dst, strokeRgb.r, strokeRgb.g, strokeRgb.b, strokeAlpha)
  }
}

/** 渲染纯色或渐变填充的圆角矩形 */
function paintFilledRoundRect(dst, px, py, pixelScale, x, y, w, h, r, colorOrGrad) {
  const sd = sdRoundedRect(px, py, x, y, w, h, r)
  const a = coverage(sd, pixelScale)
  if (a <= 0) return
  if (colorOrGrad.isGrad) {
    const tx = Math.max(0, Math.min(1, (px - x) / w))
    const ty = Math.max(0, Math.min(1, (py - y) / h))
    const t = (tx + ty) * 0.5
    const cr = COLORS.gradStart.r + (COLORS.gradEnd.r - COLORS.gradStart.r) * t
    const cg = COLORS.gradStart.g + (COLORS.gradEnd.g - COLORS.gradStart.g) * t
    const cb = COLORS.gradStart.b + (COLORS.gradEnd.b - COLORS.gradStart.b) * t
    blend(dst, cr, cg, cb, a)
  } else {
    blend(dst, colorOrGrad.r, colorOrGrad.g, colorOrGrad.b, a)
  }
}

/**
 * 渲染指定尺寸 (size x size) 的 32bpp Windows ICO DIB 数据块（含 BITMAPINFOHEADER + BGRA XOR + AND 掩码）
 */
function renderIcoFrameDib(size) {
  const xorSize = size * size * 4
  const andStride = Math.ceil(size / 32) * 4
  const andSize = andStride * size
  const buf = Buffer.alloc(40 + xorSize + andSize)

  // 1. BITMAPINFOHEADER (40 字节)
  buf.writeUInt32LE(40, 0)
  buf.writeInt32LE(size, 4)
  buf.writeInt32LE(size * 2, 8) // ICO 规范：高度为 XOR 与 AND 高度之和
  buf.writeUInt16LE(1, 12)
  buf.writeUInt16LE(32, 14)
  buf.writeUInt32LE(0, 16)
  buf.writeUInt32LE(xorSize + andSize, 20)

  const pixelScale = 512 / size
  const gradMarker = { isGrad: true }
  const dst = { r: 0, g: 0, b: 0, a: 0 }

  // 2. 自底向上写入 BGRA 像素数据
  for (let row = 0; row < size; row++) {
    const yIdx = size - 1 - row
    const py = (yIdx + 0.5) * pixelScale
    const rowOffset = 40 + row * size * 4

    for (let col = 0; col < size; col++) {
      const px = (col + 0.5) * pixelScale
      dst.r = 0
      dst.g = 0
      dst.b = 0
      dst.a = 0

      // (1) 纸感圆角底板
      paintStrokedRoundRect(dst, px, py, pixelScale, 24, 24, 464, 464, 96, COLORS.bg, COLORS.stroke, 16)
      // (2) 错位牛皮纸色块装饰
      paintFilledRoundRect(dst, px, py, pixelScale, 76, 76, 160, 128, 16, COLORS.kraftDeco)
      // (3) 内页手账白纸卡
      paintStrokedRoundRect(dst, px, py, pixelScale, 96, 96, 320, 320, 24, COLORS.cardBg, COLORS.stroke, 14)
      // (4) 顶部手绘标题横线
      paintFilledRoundRect(dst, px, py, pixelScale, 136, 142, 168, 14, 7, COLORS.title1)
      paintFilledRoundRect(dst, px, py, pixelScale, 136, 170, 112, 10, 5, COLORS.title2)
      // (5) 量化三柱
      paintFilledRoundRect(dst, px, py, pixelScale, 142, 286, 44, 82, 10, gradMarker)
      paintFilledRoundRect(dst, px, py, pixelScale, 206, 214, 44, 154, 10, gradMarker)
      paintFilledRoundRect(dst, px, py, pixelScale, 270, 250, 44, 118, 10, gradMarker)
      // (6) 规划折角标识
      const cornerAlpha = coverage(sdCornerPath(px, py, 7), pixelScale)
      if (cornerAlpha > 0) {
        blend(dst, COLORS.stroke.r, COLORS.stroke.g, COLORS.stroke.b, cornerAlpha)
      }

      const pOff = rowOffset + col * 4
      const alphaByte = Math.round(dst.a * 255)
      buf[pOff] = Math.round(dst.b)
      buf[pOff + 1] = Math.round(dst.g)
      buf[pOff + 2] = Math.round(dst.r)
      buf[pOff + 3] = alphaByte

      // 若完全透明，同时设置 AND 掩码对应位为 1
      if (alphaByte === 0) {
        const andByteIndex = 40 + xorSize + row * andStride + (col >> 3)
        buf[andByteIndex] |= 1 << (7 - (col & 7))
      }
    }
  }

  return buf
}

/** 生成包含 256/128/64/48/32/16 六种尺寸的标准 icon.ico 文件 */
function buildMultiSizeIcon(outPath) {
  const sizes = [256, 128, 64, 48, 32, 16]
  const frames = sizes.map((sz) => ({ size: sz, dib: renderIcoFrameDib(sz) }))

  const headerSize = 6 + frames.length * 16
  const totalSize = headerSize + frames.reduce((sum, f) => sum + f.dib.length, 0)
  const ico = Buffer.alloc(totalSize)

  // ICONDIR 头部
  ico.writeUInt16LE(0, 0)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(frames.length, 4)

  let offset = headerSize
  frames.forEach((f, i) => {
    const entryOff = 6 + i * 16
    const dim = f.size >= 256 ? 0 : f.size
    ico[entryOff] = dim
    ico[entryOff + 1] = dim
    ico[entryOff + 2] = 0
    ico[entryOff + 3] = 0
    ico.writeUInt16LE(1, entryOff + 4)
    ico.writeUInt16LE(32, entryOff + 6)
    ico.writeUInt32LE(f.dib.length, entryOff + 8)
    ico.writeUInt32LE(offset, entryOff + 12)
    f.dib.copy(ico, offset)
    offset += f.dib.length
  })

  fs.writeFileSync(outPath, ico)
}

/** 查找系统内置 .NET Framework C# 编译器 (csc.exe) */
function findCscCompiler() {
  const winDir = process.env.WINDIR || 'C:\\Windows'
  const candidates = [
    path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    path.join(winDir, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ]
  return candidates.find((p) => fs.existsSync(p)) || null
}

/** 生成 C# 原生启动器源码（无黑框 + 独立软件窗口 + 关窗即停服务） */
function generateLauncherCsSource(fallbackProjectRoot) {
  const escapedRoot = fallbackProjectRoot.replace(/\\/g, '\\\\')
  return `using System;
using System.IO;
using System.Net;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("MAERS QLS")]
[assembly: AssemblyDescription("MAERS QLS — 统一生活量化与时间管理系统桌面启动器")]
[assembly: AssemblyProduct("MAERS QLS")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace MAERSLauncher
{
    internal static class Program
    {
        // 编译时固化的项目根目录路径，确保将 .exe 单独复制到桌面或任意文件夹时仍可直接启动
        private const string FallbackProjectRoot = "${escapedRoot}";
        private const int DefaultPort = 8081;
        private const int MaxPortProbe = DefaultPort + 7;

        // Win32 窗口管理 API：用于检测独立应用窗口打开/关闭状态及置顶唤醒
        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        private static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);

        private const int SW_RESTORE = 9;

        [STAThread]
        private static void Main()
        {
            Process serverProc = null;
            try
            {
                int activePort = FindRunningQlsPort();

                // 1. 若独立窗口已打开，直接还原并置顶唤醒，防止重复开启
                IntPtr existingWin = FindQlsAppWindow();
                if (existingWin != IntPtr.Zero && activePort > 0)
                {
                    if (IsIconic(existingWin)) ShowWindow(existingWin, SW_RESTORE);
                    SetForegroundWindow(existingWin);
                    return;
                }

                // 2. 若后台服务尚未运行，则以无黑框静默方式启动 node dev-server.js --no-open
                if (activePort <= 0)
                {
                    string projectDir = ResolveProjectDirectory();
                    if (projectDir == null)
                    {
                        MessageBox.Show(
                            "未找到 MAERS-QLS 服务脚本 (scripts/dev-server.js)。\\n请将此程序置于 MAERS-QLS 项目根目录或重新运行 npm run build:exe。",
                            "MAERS QLS 启动失败",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                        return;
                    }

                    serverProc = StartSilentNodeServer(projectDir);
                    activePort = WaitUntilServerReady(8000);
                    if (activePort <= 0)
                    {
                        StopServerProcess(serverProc);
                        MessageBox.Show(
                            "本地服务启动超时，请确认系统已安装 Node.js (>= 22)。",
                            "MAERS QLS 启动失败",
                            MessageBoxButtons.OK,
                            MessageBoxIcon.Warning
                        );
                        return;
                    }
                }

                // 3. 通过 Chromium (Edge / Chrome) --app 模式打开无地址栏、无书签栏的独立桌面软件窗口
                string appUrl = "http://localhost:" + activePort;
                Process browserProc = OpenStandaloneWindow(appUrl);

                // 4. 若本次启动拉起了后台服务，则监测独立软件窗口生命周期，关闭窗口时自动停止后台服务
                if (serverProc != null)
                {
                    MonitorWindowAndStopServer(serverProc, browserProc);
                }
            }
            catch (Exception ex)
            {
                StopServerProcess(serverProc);
                MessageBox.Show(
                    "启动 MAERS-QLS 时发生异常：\\n" + ex.Message,
                    "MAERS QLS 启动错误",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        // 后台无黑框静默启动 node scripts/dev-server.js --no-open
        private static Process StartSilentNodeServer(string projectDir)
        {
            string scriptPath = Path.Combine(projectDir, "scripts", "dev-server.js");
            if (!File.Exists(scriptPath)) scriptPath = Path.Combine(projectDir, "dev-server.js");
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = ResolveNodeExecutable();
            psi.Arguments = "\\"" + scriptPath + "\\" --no-open";
            psi.WorkingDirectory = projectDir;
            psi.CreateNoWindow = true;
            psi.UseShellExecute = false;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            return Process.Start(psi);
        }

        // 定位 node.exe 路径
        private static string ResolveNodeExecutable()
        {
            string[] commonPaths = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe")
            };
            foreach (string p in commonPaths)
            {
                if (File.Exists(p)) return p;
            }
            return "node";
        }

        // 探测 8081..8088 范围内已运行的 MAERS-QLS 服务端口（兼容 dev-server 端口顺延）
        private static int FindRunningQlsPort()
        {
            for (int port = DefaultPort; port <= MaxPortProbe; port++)
            {
                if (IsQlsServerRunning(port)) return port;
            }
            return -1;
        }

        // 轮询等待本地服务就绪并返回实际监听端口
        private static int WaitUntilServerReady(int timeoutMs)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < timeoutMs)
            {
                int port = FindRunningQlsPort();
                if (port > 0) return port;
                Thread.Sleep(80);
            }
            return FindRunningQlsPort();
        }

        // 以 --app 模式启动无地址栏独立软件窗口（优先匹配系统默认浏览器以共享 IndexedDB 存储）
        private static Process OpenStandaloneWindow(string url)
        {
            string browserExe = ResolveChromiumBrowser();
            if (!string.IsNullOrEmpty(browserExe))
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = browserExe;
                psi.Arguments = "--app=" + url;
                psi.UseShellExecute = false;
                return Process.Start(psi);
            }

            // 回退：使用系统默认浏览器打开
            ProcessStartInfo fallbackPsi = new ProcessStartInfo();
            fallbackPsi.FileName = url;
            fallbackPsi.UseShellExecute = true;
            return Process.Start(fallbackPsi);
        }

        // 解析系统首选的 Chromium 内核浏览器 (Edge / Chrome)
        private static string ResolveChromiumBrowser()
        {
            string progId = "";
            try
            {
                using (RegistryKey key = Registry.CurrentUser.OpenSubKey(@"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice"))
                {
                    if (key != null)
                    {
                        object val = key.GetValue("ProgId");
                        if (val != null) progId = val.ToString();
                    }
                }
            }
            catch { }

            string chromePath = FindFirstExisting(new string[]
            {
                @"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                @"C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\\Chrome\\Application\\chrome.exe")
            });

            string edgePath = FindFirstExisting(new string[]
            {
                @"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                @"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\\Edge\\Application\\msedge.exe")
            });

            if (progId.StartsWith("ChromeHTML", StringComparison.OrdinalIgnoreCase) && chromePath != null)
                return chromePath;
            if (progId.StartsWith("MSEdge", StringComparison.OrdinalIgnoreCase) && edgePath != null)
                return edgePath;

            return chromePath ?? edgePath;
        }

        private static string FindFirstExisting(string[] paths)
        {
            foreach (string p in paths)
            {
                if (!string.IsNullOrEmpty(p) && File.Exists(p)) return p;
            }
            return null;
        }

        // 监测独立窗口句柄：当窗口被用户关闭后，自动停止后台 Node 服务进程
        private static void MonitorWindowAndStopServer(Process serverProc, Process browserProc)
        {
            IntPtr trackedHwnd = IntPtr.Zero;
            Stopwatch waitOpen = Stopwatch.StartNew();

            // 阶段 1：等待独立窗口创建完成（最多等待 15 秒）
            while (waitOpen.ElapsedMilliseconds < 15000)
            {
                if (serverProc.HasExited) return;
                trackedHwnd = FindQlsAppWindow();
                if (trackedHwnd != IntPtr.Zero) break;
                Thread.Sleep(150);
            }

            // 若捕获到了顶层窗口句柄，持续监测该窗口或任意 QLS 窗口是否仍处于打开状态
            if (trackedHwnd != IntPtr.Zero)
            {
                while (!serverProc.HasExited)
                {
                    if (IsWindow(trackedHwnd))
                    {
                        Thread.Sleep(400);
                        continue;
                    }
                    // 原窗口句柄销毁后，再检查是否还有其他 QLS 窗口打开
                    IntPtr another = FindQlsAppWindow();
                    if (another != IntPtr.Zero)
                    {
                        trackedHwnd = another;
                        Thread.Sleep(400);
                        continue;
                    }
                    break;
                }
            }
            else if (browserProc != null)
            {
                // 极端回退：若未捕获到窗口句柄则等待浏览器进程结束
                try { browserProc.WaitForExit(); } catch { }
            }

            StopServerProcess(serverProc);
        }

        // 查找当前打开的 MAERS QLS / Schedule / QuantiLife 浏览器窗口句柄
        private static IntPtr FindQlsAppWindow()
        {
            IntPtr found = IntPtr.Zero;
            EnumWindows(delegate (IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;

                StringBuilder clsSb = new StringBuilder(128);
                GetClassName(hWnd, clsSb, clsSb.Capacity);
                string cls = clsSb.ToString();
                if (!cls.StartsWith("Chrome_WidgetWin_", StringComparison.Ordinal)) return true;

                StringBuilder titleSb = new StringBuilder(256);
                GetWindowText(hWnd, titleSb, titleSb.Capacity);
                string title = titleSb.ToString();

                if (title.StartsWith("MAERS QLS", StringComparison.OrdinalIgnoreCase) ||
                    title.StartsWith("MAERS Schedule", StringComparison.OrdinalIgnoreCase) ||
                    title.StartsWith("MAERS QuantiLife", StringComparison.OrdinalIgnoreCase))
                {
                    found = hWnd;
                    return false;
                }
                return true;
            }, IntPtr.Zero);
            return found;
        }

        // 安全终止后台 Node 进程
        private static void StopServerProcess(Process proc)
        {
            if (proc == null) return;
            try
            {
                if (!proc.HasExited)
                {
                    proc.Kill();
                    proc.WaitForExit(2000);
                }
            }
            catch { }
        }

        // 探测指定端口是否已运行 MAERS-QLS 服务
        private static bool IsQlsServerRunning(int port)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + "/manifest.webmanifest");
                req.Method = "GET";
                req.Timeout = 350;
                req.ReadWriteTimeout = 350;
                req.Proxy = null;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    if (res.StatusCode != HttpStatusCode.OK) return false;
                    string appHeader = res.Headers["X-MAERS-App"];
                    if (appHeader == "MAERS-QLS") return true;
                    using (StreamReader sr = new StreamReader(res.GetResponseStream()))
                    {
                        string content = sr.ReadToEnd();
                        return content != null && content.IndexOf("MAERS QLS", StringComparison.OrdinalIgnoreCase) >= 0;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        // 解析有效的项目根目录
        private static string ResolveProjectDirectory()
        {
            string baseDir = AppDomain.CurrentDomain.BaseDirectory;
            if (IsValidProjectDir(baseDir)) return baseDir;
            if (IsValidProjectDir(FallbackProjectRoot)) return FallbackProjectRoot;
            return null;
        }

        private static bool IsValidProjectDir(string dir)
        {
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return false;
            return File.Exists(Path.Combine(dir, "scripts", "dev-server.js")) || File.Exists(Path.Combine(dir, "dev-server.js"));
        }
    }
}
`
}

function main() {
  console.log('[1/3] 正在生成六尺寸 (256~16px) 高清图标:', ICON_PATH)
  buildMultiSizeIcon(ICON_PATH)

  const cscPath = findCscCompiler()
  if (!cscPath) {
    throw new Error('未找到 Windows 内置 .NET C# 编译器 (csc.exe)')
  }

  const tempCs = path.join(os.tmpdir(), `MAERS_QLS_Launcher_${process.pid}.cs`)
  // 写入 UTF-8 BOM 以确保 csc.exe 按 UTF-8 解析中文提示与元数据
  fs.writeFileSync(tempCs, '\uFEFF' + generateLauncherCsSource(ROOT), 'utf8')

  console.log('[2/3] 正在编译原生桌面启动程序 (纯桌面软件模式):', EXE_PATH)
  try {
    execFileSync(
      cscPath,
      [
        '/nologo',
        '/target:winexe',
        '/optimize+',
        `/out:${EXE_PATH}`,
        `/win32icon:${ICON_PATH}`,
        '/r:System.dll',
        '/r:System.Windows.Forms.dll',
        tempCs,
      ],
      { stdio: 'inherit' }
    )
  } finally {
    if (fs.existsSync(tempCs)) fs.unlinkSync(tempCs)
  }

  if (fs.existsSync(DESKTOP_DIR)) {
    console.log('[3/3] 正在同步复制到系统桌面:', DESKTOP_EXE_PATH)
    fs.copyFileSync(EXE_PATH, DESKTOP_EXE_PATH)
  }

  console.log('✅ 构建完成！')
}

if (require.main === module) {
  main()
}

module.exports = { buildMultiSizeIcon, renderIcoFrameDib, generateLauncherCsSource, findCscCompiler }
