'use strict';
// Faster static files, with no extra packages. Sits in front of express.static and changes only how
// the bytes travel, never what they are:
//   * text files (js, css, html, svg, json…) go out brotli- or gzip-compressed when the browser accepts it
//     (compressed once per file version and kept in memory);
//   * in the HTML pages every local script / style / image link gets ?v=<content hash>, so the browser
//     can keep those files for a year (see the ?v= rule in server.js) and a new deploy changes the URL;
//   * ETag + 304, so an unchanged file is never sent twice.
// Anything it does not handle (images, Range requests, a file not ready yet) falls through to
// express.static exactly as before.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const COMPRESSIBLE = /\.(js|mjs|css|html?|svg|json|txt|map|webmanifest|xml)$/i;
const MIN_COMPRESS = 1024; // smaller files are not worth it
const HTML = /\.html?$/i;

/**
 * roots: [{ prefix: '/', dir, cacheControl: 'public, max-age=0' }, …] — in the same order as the
 * express.static mounts they shadow (the first root that has the file wins, as with express.static).
 */
function createStaticFast(roots) {
  const norm = roots.map((r) => ({
    prefix: r.prefix === '/' ? '' : r.prefix.replace(/\/$/, ''),
    dir: path.resolve(r.dir),
    cacheControl: r.cacheControl || 'public, max-age=0',
  }));
  const cache = new Map(); // file -> { key, entry | pending }

  /** URL path ("/meli/app.js") -> { file, root } or null. Never leaves the root, never serves dotfiles. */
  function locate(urlPath) {
    let p;
    try { p = decodeURIComponent(urlPath); } catch { return null; }
    if (p.includes('\0')) return null;
    for (const root of norm) {
      if (root.prefix && !(p === root.prefix || p.startsWith(root.prefix + '/'))) continue;
      let rel = p.slice(root.prefix.length) || '/';
      if (rel.endsWith('/')) rel += 'index.html';
      if (rel.split('/').some((seg) => seg.startsWith('.') && seg.length > 0)) return null;
      const file = path.resolve(root.dir, '.' + rel);
      if (file !== root.dir && !file.startsWith(root.dir + path.sep)) return null;
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      if (!st.isFile()) continue;
      return { file, root, st };
    }
    return null;
  }

  // Short content hashes of local files, for ?v= in the pages.
  const hashes = new Map(); // file -> { key, hash }
  function fileHash(file, st) {
    const key = st.size + ':' + st.mtimeMs;
    const h = hashes.get(file);
    if (h && h.key === key) return h.hash;
    const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
    hashes.set(file, { key, hash });
    return hash;
  }

  /** Adds ?v=<hash> to local src/href links in a page that don't carry a query yet. pageUrl: the page's URL path. */
  function versionLinks(html, pageUrl, used = []) {
    const base = pageUrl.endsWith('/') ? pageUrl : pageUrl.slice(0, pageUrl.lastIndexOf('/') + 1);
    return html.replace(/(\s(?:src|href)=)(["'])([^"'?#]+\.(?:js|css|svg|png|webp|woff2?))\2/gi, (m, attr, q, ref) => {
      if (/^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) return m; // other sites, data: …
      const url = ref.startsWith('/') ? ref : base + ref;
      const hit = locate(path.posix.normalize(url));
      if (!hit) return m;
      used.push([hit.file, hit.st.size + ':' + hit.st.mtimeMs]);
      return `${attr}${q}${ref}?v=${fileHash(hit.file, hit.st)}${q}`;
    });
  }

  function build(file, st, urlPath) {
    let body = fs.readFileSync(file);
    const used = [];
    if (HTML.test(file)) body = Buffer.from(versionLinks(body.toString('utf8'), urlPath, used), 'utf8');
    const etag = '"' + crypto.createHash('sha1').update(body).digest('base64url').slice(0, 22) + '"';
    const entry = { identity: body, etag, br: null, gzip: null, mtime: st.mtime.toUTCString(), used };
    if (body.length < MIN_COMPRESS) return Promise.resolve(entry);
    const br = new Promise((ok) => zlib.brotliCompress(body, {
      params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
    }, (err, out) => ok(err ? null : out)));
    const gz = new Promise((ok) => zlib.gzip(body, { level: 9 }, (err, out) => ok(err ? null : out)));
    return Promise.all([br, gz]).then(([b, g]) => {
      if (b && b.length < body.length) entry.br = b;
      if (g && g.length < body.length) entry.gzip = g;
      return entry;
    });
  }

  // A page carries its linked files' hashes, so a changed script/style rebuilds the page.
  function linksChanged(entry) {
    return entry.used.some(([f, k]) => {
      try { const s = fs.statSync(f); return s.size + ':' + s.mtimeMs !== k; } catch { return true; }
    });
  }

  /** The prepared file, or null while it is still being prepared (that request is served the old way). */
  function get(file, st, urlPath) {
    const key = st.size + ':' + st.mtimeMs;
    const c = cache.get(file);
    if (c && c.key === key && c.entry && !linksChanged(c.entry)) return c.entry;
    if (c && c.key === key && c.pending) return null;
    const rec = { key, entry: null, pending: true };
    cache.set(file, rec);
    let built;
    try { built = build(file, st, urlPath); } catch { cache.delete(file); return null; }
    built.then((entry) => {
      rec.entry = entry; rec.pending = false;
    }, () => cache.delete(file));
    return null;
  }

  function pickEncoding(req, entry) {
    const ae = String(req.headers['accept-encoding'] || '');
    if (entry.br && /\bbr\b/.test(ae)) return 'br';
    if (entry.gzip && /\bgzip\b/.test(ae)) return 'gzip';
    return 'identity';
  }

  function send(req, res, entry, ext, cacheControl) {
    const enc = pickEncoding(req, entry);
    const body = enc === 'identity' ? entry.identity : entry[enc];
    const etag = enc === 'identity' ? entry.etag : entry.etag.slice(0, -1) + '-' + enc + '"';
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', entry.mtime);
    res.setHeader('Cache-Control', res.locals && res.locals.immutable ? 'public, max-age=31536000, immutable' : cacheControl);
    if (!res.getHeader('Content-Type')) res.type(ext);
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === etag)) { res.statusCode = 304; return res.end(); }
    if (enc !== 'identity') res.setHeader('Content-Encoding', enc);
    res.setHeader('Content-Length', body.length);
    res.statusCode = 200;
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  /** Middleware for the static roots. */
  function middleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers.range) return next();
    const urlPath = req.path;
    const looksText = urlPath.endsWith('/') || COMPRESSIBLE.test(urlPath);
    if (!looksText) return next();
    const hit = locate(urlPath);
    if (!hit || !COMPRESSIBLE.test(hit.file)) return next();
    const entry = get(hit.file, hit.st, urlPath);
    if (!entry) return next();
    send(req, res, entry, path.extname(hit.file), hit.root.cacheControl);
  }

  /** For page routes (res.sendFile replacement): file + the URL the page is shown at + Cache-Control. */
  function sendPage(req, res, file, pageUrl, cacheControl = 'public, max-age=0') {
    let st;
    try { st = fs.statSync(file); } catch { return res.sendStatus(404); }
    const entry = get(path.resolve(file), st, pageUrl);
    if (!entry) return res.sendFile(file);
    send(req, res, entry, '.html', cacheControl);
  }

  /** Prepares every text file in the roots ahead of the first visitor. */
  function warm() {
    for (const root of norm) {
      const walk = (dir, url) => {
        let list;
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of list) {
          if (e.name.startsWith('.')) continue;
          const f = path.join(dir, e.name);
          const u = url + '/' + e.name;
          if (e.isDirectory()) walk(f, u);
          else if (COMPRESSIBLE.test(e.name)) { const hit = locate(u); if (hit && hit.file === f) get(f, hit.st, u); }
        }
      };
      walk(root.dir, root.prefix);
    }
  }

  return { middleware, sendPage, warm, versionLinks };
}

/** Sends JSON, gzip-compressed when it is big enough and the browser accepts it (for polled API answers). */
function sendJson(req, res, data) {
  const body = Buffer.from(JSON.stringify(data), 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Vary', 'Accept-Encoding');
  if (body.length >= MIN_COMPRESS && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    return zlib.gzip(body, { level: 6 }, (err, out) => {
      if (err) { res.setHeader('Content-Length', body.length); return res.end(body); }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', out.length);
      res.end(out);
    });
  }
  res.setHeader('Content-Length', body.length);
  res.end(body);
}

module.exports = { createStaticFast, sendJson };
