import { execFile } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import http from 'node:http';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ROOT, sha256 } from './common.mjs';

const exec = promisify(execFile);
const BENCH = resolve(ROOT, 'bench');
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};
const BENCH_FILES = new Set(['csp-probe.js', 'tauri-stub.js', 'fixtures.mjs']);
const validPath = (path) =>
  /^[A-Za-z0-9_./-]+$/.test(path) &&
  !path.split('/').some((p) => !p || p === '.' || p === '..') &&
  Object.hasOwn(TYPES, extname(path));

async function git(args) {
  return (
    await exec('git', ['--no-pager', ...args], {
      cwd: ROOT,
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15000,
    })
  ).stdout;
}

/**
 * `loose` is what the harness has always sent: it allows 'unsafe-inline' and `data:` images so
 * that injecting fixtures never fights the page. The cost is that bench:ui could never catch a CSP
 * regression, because it was not enforcing the rule the app ships with. `shipped` serves the exact
 * `app.security.csp` from tauri.conf.json instead, which is the only way this harness can answer
 * "does the real policy block this asset?" — a blocked icon mask otherwise shows no console output
 * and no failed request in the loose mode.
 */
export const CSP_MODES = {
  loose:
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
  shipped: null,
};

export async function startUiServer({ port = 0, revision = null, csp = 'loose', dist = '' } = {}) {
  if (!(csp in CSP_MODES)) throw new Error(`Unknown csp mode: ${csp}`);
  // `dist` serves the built frontend instead of src/, so the question "does the shipped artifact
  // boot?" is answerable at all. Mutually exclusive with --revision by construction: history A/B
  // reads `git show <sha>:src/<path>`, and that only exists for unbundled sources.
  if (dist && revision !== null) throw new Error('--dist 与 --revision 互斥：历史对照只在未打包源码上可行');
  const requestedRoot = resolve(ROOT, dist || 'src');
  const serveRoot = await realpath(requestedRoot).catch(() => null);
  if (!serveRoot) throw new Error(`服务目录不存在: ${dist || 'src'}（构建产物请先跑 npm run build）`);
  const relRoot = relative(ROOT, serveRoot);
  if (!relRoot || relRoot.startsWith(`..${sep}`) || relRoot === '..' || isAbsolute(relRoot))
    throw new Error(`--dist 必须是仓库内的目录: ${dist}`);
  const serveDir = relRoot.split(sep).join('/');
  let cspHeader = CSP_MODES[csp];
  if (csp === 'shipped') {
    const conf = JSON.parse(await readFile(resolve(ROOT, 'src-tauri/tauri.conf.json'), 'utf8'));
    cspHeader = conf?.app?.security?.csp;
    if (!cspHeader) throw new Error('tauri.conf.json 里没有 app.security.csp，无法按发货策略服务');
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer in 0..65535');
  let commit = null;
  if (revision !== null) {
    if (!/^(HEAD|[0-9a-fA-F]{7,64})$/.test(revision))
      throw new Error('--revision accepts only HEAD or a local commit hash (no refs, ranges, paths or options)');
    try {
      commit = (await git(['rev-parse', '--verify', '--end-of-options', `${revision}^{commit}`])).toString().trim();
      if (!/^[0-9a-f]{40,64}$/.test(commit)) throw new Error('Invalid resolved commit');
    } catch (error) {
      throw new Error(`Cannot resolve local commit ${revision}: ${error.message}`);
    }
  }
  // Cache only bytes actually requested: a page never rereads a changed module.
  // Disk-mode modifications during a run are reported, not hidden.
  const cache = new Map(),
    manifest = new Map(),
    failures = [];
  async function asset(path, isBench) {
    const key = `${isBench ? 'bench' : serveDir}/${path}`;
    if (cache.has(key)) return cache.get(key);
    const promise = (async () => {
      let bytes;
      let mtimeMs = null;
      if (commit && !isBench) {
        bytes = await git(['show', `${commit}:src/${path}`]);
      } else {
        const base = isBench ? BENCH : serveRoot;
        const full = await realpath(resolve(base, path));
        const rel = relative(await realpath(base), full);
        if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(base, rel) !== full)
          throw new Error('Path leaves allowed source directory');
        bytes = await readFile(full);
        mtimeMs = (await stat(full)).mtimeMs;
      }
      manifest.set(key, { sha256: sha256(bytes), bytes: bytes.length, mtimeMs });
      return bytes;
    })();
    cache.set(key, promise);
    try {
      return await promise;
    } catch (error) {
      cache.delete(key);
      throw error;
    }
  }
  // Resolve the entry before listening, so invalid revisions fail immediately.
  await asset('index.html', false);
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', cspHeader);
    try {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405, { Allow: 'GET, HEAD' });
        res.end('GET/HEAD only');
        return;
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/__bench/health') {
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            environment: 'Edge + simulated Tauri, NOT native WebView',
            mode: commit ? 'git' : 'disk',
            requestedRevision: revision,
            commit,
            files: Object.fromEntries(manifest),
          }),
        );
        return;
      }
      const isBench = url.pathname.startsWith('/__bench/');
      const path = decodeURIComponent(
        url.pathname === '/' ? 'index.html' : url.pathname.slice(isBench ? '/__bench/'.length : 1),
      );
      if (!validPath(path) || (isBench && !BENCH_FILES.has(path))) {
        res.writeHead(403);
        res.end('Path is outside the benchmark allowlist');
        return;
      }
      let bytes = await asset(path, isBench);
      if (!isBench && path === 'index.html') {
        const html = bytes.toString('utf8');
        if (!/<head(?:\s[^>]*)?>/i.test(html)) throw new Error(`${serveDir}/index.html is missing <head>`);
        // Synchronous classic scripts execute before any real application script. The CSP probe
        // goes first: a blocked load has to be observed before it happens.
        bytes = Buffer.from(
          html.replace(
            /<head(?:\s[^>]*)?>/i,
            '$&<script src="/__bench/csp-probe.js"></script><script src="/__bench/tauri-stub.js"></script>',
          ),
        );
      }
      res.setHeader(
        'Content-Type',
        `${TYPES[extname(path)]}${/\.(html|css|m?js|json)$/.test(path) ? '; charset=utf-8' : ''}`,
      );
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      failures.push({ url: req.url, message: error.message });
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Benchmark asset unavailable: ${req.url}\n${error.message}`);
    }
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, '127.0.0.1', yes);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    commit,
    async describe() {
      const changedSinceServed = [];
      for (const [path, info] of manifest) {
        if (commit && path.startsWith('src/')) continue;
        try {
          if (sha256(await readFile(resolve(ROOT, path))) !== info.sha256) changedSinceServed.push(path);
        } catch {
          changedSinceServed.push(path);
        }
      }
      return {
        url,
        mode: commit ? 'git' : 'disk',
        servedFrom: serveDir,
        cspMode: csp,
        contentSecurityPolicy: cspHeader,
        requestedRevision: revision,
        commit,
        files: Object.fromEntries([...manifest].sort(([a], [b]) => a.localeCompare(b))),
        changedSinceServed,
        failures,
      };
    },
    close: () =>
      new Promise((yes, no) => {
        server.close((error) => (error ? no(error) : yes()));
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const opts = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg === '--help') {
        console.log(
          'node bench/ui-server.mjs [--port 0..65535] [--revision HEAD|LOCAL_COMMIT_HASH] [--dist out] [--csp loose|shipped]',
        );
        process.exit(0);
      }
      if (!['--port', '--revision', '--dist', '--csp'].includes(arg))
        throw new Error(`Unknown option: ${arg}; use --help`);
      const value = process.argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      opts[arg.slice(2)] = arg === '--port' ? Number(value) : value;
    }
    const server = await startUiServer(opts);
    console.log(JSON.stringify({ event: 'ui-server-ready', ...(await server.describe()) }));
    for (const signal of ['SIGINT', 'SIGTERM'])
      process.once(signal, async () => {
        await server.close();
        process.exit(0);
      });
  } catch (error) {
    console.error(`[bench:ui:server] ${error.stack}`);
    process.exitCode = 1;
  }
}
