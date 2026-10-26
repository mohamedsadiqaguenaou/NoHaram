// Fetches an image with the extension's host permissions (no canvas tainting, no CORS) and
// decodes it straight to a small ImageBitmap, so a 4000px photo never sits in memory at full size.

/** Longest side of the decoded bitmap. Stage 1 needs 160px, faces need ~320px of context. */
export const DECODE_MAX_SIDE = 640;
const MAX_BYTES = 40 * 1024 * 1024;

export class SkipImage extends Error {}

/**
 * @param job.url      image URL (http(s) or data:)
 * @param job.dataUrl  pixels the content script extracted itself (blob: images, failed fetches)
 * @returns {Promise<{bitmap: ImageBitmap, w: number, h: number}>}
 */
export async function loadBitmap(job) {
  const source = job.dataUrl || job.url;
  let res;
  try {
    res = await fetch(source, { credentials: 'include', cache: 'force-cache', redirect: 'follow' });
  } catch (err) {
    throw Object.assign(new Error(`fetch failed: ${err?.message || err}`), { code: 'fetch' });
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'fetch' });
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.includes('svg')) throw new SkipImage('svg');
  if (type.startsWith('text/') || type.includes('json') || type.includes('html')) throw new SkipImage('not an image');
  const blob = await res.blob();
  if (blob.size > MAX_BYTES) throw new SkipImage('too large');

  const head = new Uint8Array(await blob.slice(0, 64 * 1024).arrayBuffer());
  const dims = probeSize(head) ?? (job.w && job.h ? { w: job.w, h: job.h } : null);
  let bitmap;
  try {
    if (dims && Math.max(dims.w, dims.h) > DECODE_MAX_SIDE) {
      // Give only the long side: the browser keeps the real (EXIF-oriented) aspect ratio.
      const opts = dims.w >= dims.h ? { resizeWidth: DECODE_MAX_SIDE } : { resizeHeight: DECODE_MAX_SIDE };
      bitmap = await createImageBitmap(blob, { ...opts, resizeQuality: 'high' });
    } else {
      bitmap = await createImageBitmap(blob);
    }
  } catch (err) {
    throw Object.assign(new Error(`decode failed: ${err?.message || err}`), { code: 'decode' });
  }
  if (bitmap.width < 16 || bitmap.height < 16) {
    bitmap.close();
    throw new SkipImage('tiny');
  }
  const w = dims?.w ?? bitmap.width;
  const h = dims?.h ?? bitmap.height;
  return { bitmap, w, h };
}

/** Reads width/height from PNG, GIF, JPEG, WebP or AVIF headers without decoding. */
export function probeSize(b) {
  const u16be = (o) => (b[o] << 8) | b[o + 1];
  const u16le = (o) => b[o] | (b[o + 1] << 8);
  const u32be = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (b.length < 24) return null;
  // PNG
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: u32be(16), h: u32be(20) };
  // GIF
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return { w: u16le(6), h: u16le(8) };
  // WebP
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) {
    const chunk = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (chunk === 'VP8 ' && b.length >= 30) return { w: u16le(26) & 0x3fff, h: u16le(28) & 0x3fff };
    if (chunk === 'VP8L' && b.length >= 25) {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X' && b.length >= 30) {
      return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    return null;
  }
  // JPEG: walk markers to the first SOFn
  if (b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = b[o + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        o += 2;
        continue;
      }
      const len = u16be(o + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { w: u16be(o + 7), h: u16be(o + 5) };
      o += 2 + len;
    }
    return null;
  }
  // AVIF / HEIF: find the 'ispe' box
  for (let o = 4; o + 20 < b.length; o++) {
    if (b[o] === 0x69 && b[o + 1] === 0x73 && b[o + 2] === 0x70 && b[o + 3] === 0x65) {
      return { w: u32be(o + 8), h: u32be(o + 12) };
    }
  }
  return null;
}
