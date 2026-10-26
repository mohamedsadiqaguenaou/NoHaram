// Builds unpacked extensions into dist/<target>/ and optional store zips.
//
//   node scripts/build.mjs                 # all targets
//   node scripts/build.mjs chrome firefox  # some targets
//   node scripts/build.mjs --zip           # also write dist/noharam-<target>-<version>.zip
//   node scripts/build.mjs chrome --watch  # rebuild on change (dev)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const TARGETS = {
  chrome: { esTarget: ['chrome116'], offscreen: true },
  firefox: { esTarget: ['firefox128'], offscreen: false },
};
const targets = args.filter((a) => !a.startsWith('--'));
const selected = targets.length ? targets : Object.keys(TARGETS);
for (const t of selected) if (!TARGETS[t]) throw new Error(`unknown target ${t} (use ${Object.keys(TARGETS).join(', ')})`);

const ORT_WASM = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.wasm');

function manifest(target) {
  const m = {
    manifest_version: 3,
    name: '__MSG_extName__',
    short_name: 'NoHaram',
    description: '__MSG_extDescription__',
    version: pkg.version,
    default_locale: 'en',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: {
      default_title: 'NoHaram',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' },
    },
    permissions: ['storage', 'contextMenus', 'scripting'],
    host_permissions: ['<all_urls>'],
    content_scripts: [
      {
        matches: ['<all_urls>'],
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: true,
        match_about_blank: true,
      },
    ],
    // WebAssembly needs 'wasm-unsafe-eval' in MV3 extension pages and workers.
    content_security_policy: { extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" },
  };
  if (target === 'chrome') {
    m.background = { service_worker: 'background.js', type: 'module' };
    m.permissions.push('offscreen');
    m.minimum_chrome_version = '116';
  } else if (target === 'firefox') {
    m.background = { scripts: ['background.js'], type: 'module' };
    m.browser_specific_settings = {
      gecko: { id: '{6b7f3c3e-2a51-4c7e-9a43-5f2d0f9c8e17}', strict_min_version: '128.0' },
      gecko_android: { strict_min_version: '128.0' },
    };
  }
  return m;
}

function entryPoints(target) {
  const e = [
    { in: path.join(SRC, 'background', 'index.js'), out: 'background', format: 'esm' },
    { in: path.join(SRC, 'content', 'index.js'), out: 'content', format: 'iife' },
    { in: path.join(SRC, 'engine', 'worker.js'), out: 'engine-worker', format: 'esm' },
    { in: path.join(SRC, 'popup', 'popup.js'), out: 'popup', format: 'esm' },
  ];
  if (TARGETS[target].offscreen) e.push({ in: path.join(SRC, 'offscreen', 'offscreen.js'), out: 'offscreen', format: 'esm' });
  return e;
}

function copyDir(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b, filter);
    else if (filter(entry.name)) fs.copyFileSync(a, b);
  }
}

function copyStatic(target, out) {
  for (const f of ['popup/popup.html', 'popup/popup.css']) fs.copyFileSync(path.join(SRC, f), path.join(out, path.basename(f)));
  if (TARGETS[target].offscreen) fs.copyFileSync(path.join(SRC, 'offscreen', 'offscreen.html'), path.join(out, 'offscreen.html'));
  copyDir(path.join(SRC, 'icons'), path.join(out, 'icons'));
  copyDir(path.join(SRC, '_locales'), path.join(out, '_locales'));
  copyDir(path.join(SRC, 'models'), path.join(out, 'models'), (name) => name.endsWith('.onnx'));
  if (!fs.existsSync(ORT_WASM)) throw new Error('onnxruntime-web is not installed: run `npm install`');
  fs.copyFileSync(ORT_WASM, path.join(out, 'ort-wasm-simd-threaded.wasm'));
  // The bundled models and runtime come with their own licences: ship them with the extension.
  for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(path.join(ROOT, f), path.join(out, f));
  copyDir(path.join(ROOT, 'licenses'), path.join(out, 'licenses'));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest(target), null, 2));
}

async function buildTarget(target, { watch = false } = {}) {
  const out = path.join(DIST, target);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  copyStatic(target, out);
  const groups = { esm: [], iife: [] };
  for (const e of entryPoints(target)) groups[e.format].push({ in: e.in, out: e.out });
  const contexts = [];
  for (const [format, entries] of Object.entries(groups)) {
    if (!entries.length) continue;
    const ctx = await esbuild.context({
      entryPoints: entries,
      outdir: out,
      bundle: true,
      format,
      target: TARGETS[target].esTarget,
      minify: !watch,
      sourcemap: watch ? 'inline' : false,
      legalComments: 'none',
      logLevel: 'warning',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    contexts.push(ctx);
  }
  if (watch) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log(`watching ${target} -> ${path.relative(ROOT, out)}`);
    return;
  }
  await Promise.all(contexts.map((c) => c.rebuild()));
  await Promise.all(contexts.map((c) => c.dispose()));
  const size = dirSize(out);
  console.log(`built ${target.padEnd(8)} -> ${path.relative(ROOT, out)} (${(size / 1e6).toFixed(1)} MB)`);
  if (flags.has('--zip')) {
    const zipPath = path.join(DIST, `noharam-${target}-${pkg.version}.zip`);
    writeZip(out, zipPath);
    console.log(`zipped   ${target.padEnd(8)} -> ${path.relative(ROOT, zipPath)} (${(fs.statSync(zipPath).size / 1e6).toFixed(1)} MB)`);
  }
}

function dirSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return n;
}

// Minimal ZIP writer (deflate), enough for browser stores.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}
function writeZip(dir, zipPath) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const name of listFiles(dir).sort()) {
    const data = fs.readFileSync(path.join(dir, name));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt32LE(0x00210000, 10); // fixed DOS time/date (reproducible builds)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt32LE(0x00210000, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(centrals.length / 2, 8);
  end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...locals, ...centrals, end]));
}

for (const target of selected) await buildTarget(target, { watch: flags.has('--watch') });
if (!flags.has('--watch')) {
  const digest = createHash('sha256');
  for (const f of listFiles(path.join(SRC, 'models')).sort()) digest.update(fs.readFileSync(path.join(SRC, 'models', f)));
  console.log(`models sha256 ${digest.digest('hex').slice(0, 16)}`);
  console.log('\nLoad the unpacked extension from dist/<browser> (the folder with manifest.json), not from src/:');
  if (selected.includes('chrome')) console.log(`  Chrome/Edge: chrome://extensions > Developer mode > Load unpacked > ${path.join(DIST, 'chrome')}`);
  if (selected.includes('firefox')) console.log(`  Firefox:     about:debugging#/runtime/this-firefox > Load Temporary Add-on > ${path.join(DIST, 'firefox', 'manifest.json')}`);
}
