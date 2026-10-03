import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const SRC = resolve(ROOT, 'src');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export async function startServer({ port = 0 } = {}) {
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  const config = JSON.parse(await readFile(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
  const bridge = await build({
    entryPoints: [resolve(HERE, 'bridge.js')],
    bundle: true,
    format: 'iife',
    write: false,
    define: { __SHOWCASE_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'silent',
  });
  const appHtml = (await readFile(resolve(SRC, 'index.html'), 'utf8')).replace(
    '<head>',
    '<head>\n<link rel="stylesheet" href="/__showcase__/controls.css">\n<script src="/__showcase__/bridge.js"></script>',
  );
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Security-Policy', config.app.security.csp);
      let body;
      let file;
      if (pathname === '/__showcase__/bridge.js') {
        res.setHeader('Content-Type', MIME['.js']);
        body = bridge.outputFiles[0].contents;
      } else if (pathname === '/app/' || pathname === '/app/index.html') {
        res.setHeader('Content-Type', MIME['.html']);
        body = appHtml;
      } else if (pathname === '/app/assets/app-icon.png' || pathname === '/assets/app-icon.png') {
        res.setHeader('Content-Type', MIME['.png']);
        body = await readFile(resolve(ROOT, 'src-tauri/icons/128x128@2x.png'));
      } else {
        const tool = pathname.startsWith('/__showcase__/') || pathname === '/';
        const base = tool ? HERE : SRC;
        const rel = pathname === '/' ? 'preview.html' : pathname.replace(/^\/(?:__showcase__\/|app\/)?/, '');
        file = resolve(base, rel);
        if (!file.startsWith(base + sep)) throw new Error('Invalid path');
        res.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream');
        body = await readFile(file);
      }
      res.end(body);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
  await new Promise((accept, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', accept);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((accept, reject) => server.close((error) => (error ? reject(error) : accept()))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--port' || !/^\d+$/.test(args[1]))) {
    throw new Error('Usage: npm run showcase:dev -- [--port 4173]');
  }
  const server = await startServer({ port: args.length ? Number(args[1]) : 4173 });
  console.log(`laPower 开发展示工具（模拟数据）: ${server.url}`);
  console.log(`独立软件视图: ${server.url}/app/`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => server.close());
}
