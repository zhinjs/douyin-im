import { createServer, type Server } from 'http';
import QRCode from 'qrcode';
import { getLogger } from 'douyin-im';

const logger = getLogger('Demo:QR');

export interface PresentQrOptions {
  qrcodeBase64: string;
  /** API 返回的扫码页 URL，用于终端 ASCII 码 */
  scanUrl?: string;
  expireAt?: Date;
  webPort?: number;
  enableWeb?: boolean;
  enableTerminal?: boolean;
}

export interface PresentQrResult {
  webUrl?: string;
  close: () => void;
}

function buildQrHtml(qrcodeBase64: string, expireAt?: Date): string {
  const expireLine = expireAt
    ? `<p class="meta">过期时间：${expireAt.toLocaleString('zh-CN')}</p>`
    : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>抖音创作者中心 — 扫码登录</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0; min-height: 100vh;
      display: flex; align-items: center; justify-content: center;
      background: #0f0f0f; color: #f5f5f5;
    }
    main {
      text-align: center; padding: 2rem;
      background: #1a1a1a; border-radius: 16px;
      box-shadow: 0 8px 32px rgba(0,0,0,.4);
    }
    h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 .5rem; }
    .meta { color: #888; font-size: .875rem; margin: 0 0 1.5rem; }
    img {
      width: min(280px, 80vw); height: auto;
      background: #fff; padding: 12px; border-radius: 8px;
    }
    p.hint { color: #aaa; font-size: .8rem; margin-top: 1.25rem; }
  </style>
</head>
<body>
  <main>
    <h1>抖音 App 扫码登录</h1>
    ${expireLine}
    <img src="data:image/png;base64,${qrcodeBase64}" alt="登录二维码" />
    <p class="hint">打开抖音 → 扫一扫</p>
  </main>
</body>
</html>`;
}

function startQrWebServer(
  qrcodeBase64: string,
  port: number,
  expireAt?: Date,
): Promise<{ url: string; server: Server }> {
  const html = buildQrHtml(qrcodeBase64, expireAt);
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = req.url?.split('?')[0] ?? '/';
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actualPort =
        typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({ url: `http://127.0.0.1:${actualPort}/`, server });
    });
  });
}

/**
 * 在终端打印 ASCII 二维码，并可选启动本地网页预览。
 */
export async function presentQrCode(
  options: PresentQrOptions,
): Promise<PresentQrResult> {
  let server: Server | undefined;

  const close = (): void => {
    if (server) {
      server.close();
      server = undefined;
    }
  };

  if (options.enableTerminal !== false && options.scanUrl) {
    const ascii = await QRCode.toString(options.scanUrl, {
      type: 'terminal',
      small: true,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    logger.info('请用抖音 App 扫描下方二维码');
    process.stdout.write(`${ascii}\n`);
  } else if (options.enableTerminal !== false) {
    logger.warn('无扫码 URL，请使用下方网页查看二维码');
  }

  let webUrl: string | undefined;
  if (options.enableWeb !== false) {
    const port = options.webPort ?? 0;
    const { url, server: s } = await startQrWebServer(
      options.qrcodeBase64,
      port,
      options.expireAt,
    );
    server = s;
    webUrl = url;
    logger.info('浏览器打开: %s', webUrl);
  }

  const out: PresentQrResult = { close };
  if (webUrl !== undefined) out.webUrl = webUrl;
  return out;
}
