// The two-stage cascade. Runs inside a dedicated worker (or inline in the background as a
// fallback). Input is an ImageBitmap that the host already fetched and decoded at reduced size.
//
//   Stage 1  fast TinyCLIP-8M zero-shot, image squashed to 160x160: "is anybody in this picture?"
//            -> pictures with nobody in them (most of the web) stop here.
//   Stage 2  accurate TinyCLIP-39M zero-shot at 192x192 (women / men / neither)
//            + YuNet faces -> each face: TinyCLIP-39M face prompts + OpenVINO gender net
//            -> fused into the final { f, m, p }
//            and/or Marqo's NSFW classifier at 384x384 -> { n }, depending on what the user blurs
//
// Every model takes raw RGBA bytes ([1, H, W, 4] uint8) straight from getImageData:
// normalisation and layout changes live inside the ONNX graphs.
import { CONFIG, stage2Parts } from '../shared/policy.js';

const SESSION_OPTIONS = {
  executionProviders: ['wasm'],
  graphOptimizationLevel: 'all',
  executionMode: 'sequential',
  enableCpuMemArena: true,
  enableMemPattern: true,
  logSeverityLevel: 3,
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => {
  const q = clamp(p, 1e-4, 1 - 1e-4);
  return Math.log(q / (1 - q));
};

export class Pipeline {
  /**
   * @param ort       onnxruntime-web module (wasm build)
   * @param modelUrl  (fileName) => URL of a file in /models
   */
  static async create(ort, modelUrl) {
    const m = CONFIG.models;
    const load = async (file) => {
      const res = await fetch(modelUrl(file));
      if (!res.ok) throw new Error(`model ${file}: HTTP ${res.status}`);
      return ort.InferenceSession.create(new Uint8Array(await res.arrayBuffer()), SESSION_OPTIONS);
    };
    // Sequential creation keeps peak memory low on phones.
    const stage1 = await load(m.stage1.file);
    const stage2 = await load(m.stage2.file);
    const faces = await load(m.faces.file);
    const gender = await load(m.gender.file);
    const nsfw = await load(m.nsfw.file);
    return new Pipeline(ort, stage1, stage2, faces, gender, nsfw);
  }

  constructor(ort, stage1, stage2, faces, gender, nsfw) {
    this.ort = ort;
    this.stage1Session = stage1;
    this.stage2Session = stage2;
    this.faces = faces;
    this.gender = gender;
    this.nsfw = nsfw;
    this.canvases = new Map(); // persistent OffscreenCanvases, one per size
    this.quality = 'high';
  }

  /** Draw `src` (sx,sy,sw,sh) into (dx,dy,dw,dh) of a cleared cw x ch canvas and return RGBA bytes. */
  pixels(src, sx, sy, sw, sh, dx, dy, dw, dh, cw, ch) {
    const key = `${cw}x${ch}`;
    let ctx = this.canvases.get(key);
    if (!ctx) {
      ctx = new OffscreenCanvas(cw, ch).getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      this.canvases.set(key, ctx);
    }
    ctx.imageSmoothingQuality = this.quality;
    ctx.clearRect(0, 0, cw, ch); // transparent black = the zero padding the models expect
    ctx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
    const data = ctx.getImageData(0, 0, cw, ch).data;
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  tensor(bytes, h, w) {
    return new this.ort.Tensor('uint8', bytes, [1, h, w, 4]);
  }

  /** Zero-shot classification of one region (default: the whole bitmap) squashed to size x size. */
  async wholeImage(session, size, bmp, sx = 0, sy = 0, sw = bmp.width, sh = bmp.height) {
    const px = this.pixels(bmp, sx, sy, sw, sh, 0, 0, size, size, size, size);
    const out = await session.run({ pixels: this.tensor(px, size, size) }, ['image']);
    const [f, m, none] = out.image.data;
    return { f, m, p: 1 - none };
  }

  /**
   * Stage 1. Wide banners and tall strips would be distorted by squashing them into a square,
   * so they are cut into 2-3 roughly square tiles and the strongest signal wins. Returns the
   * scores and the region Stage 2 should look at (the tile most likely to contain a person).
   */
  async stage1(bmp) {
    const size = CONFIG.models.stage1.size;
    const whole = { x: 0, y: 0, w: bmp.width, h: bmp.height };
    const horizontal = bmp.width >= bmp.height;
    const long = horizontal ? bmp.width : bmp.height;
    const short = horizontal ? bmp.height : bmp.width;
    const ratio = long / short;
    if (ratio <= CONFIG.cascade.maxAspect) {
      return { scores: await this.wholeImage(this.stage1Session, size, bmp), region: whole };
    }
    const n = Math.min(CONFIG.cascade.maxTiles, Math.ceil(ratio / 1.5));
    const step = long / n;
    const scores = { f: 0, m: 0, p: 0 };
    let region = whole;
    for (let i = 0; i < n; i++) {
      const tile = horizontal ? { x: i * step, y: 0, w: step, h: short } : { x: 0, y: i * step, w: short, h: step };
      const r = await this.wholeImage(this.stage1Session, size, bmp, tile.x, tile.y, tile.w, tile.h);
      if (r.p > scores.p) region = tile;
      scores.f = Math.max(scores.f, r.f);
      scores.m = Math.max(scores.m, r.m);
      scores.p = Math.max(scores.p, r.p);
    }
    return { scores, region };
  }

  /** YuNet face detection on a top-left letterboxed square. Boxes are in bitmap pixels. */
  async detectFaces(bmp) {
    const c = CONFIG.models.faces;
    const long = Math.max(bmp.width, bmp.height);
    const S = clamp(Math.ceil(long / 32) * 32, c.minInput, c.maxInput);
    const scale = S / long;
    const dw = Math.max(1, Math.round(bmp.width * scale));
    const dh = Math.max(1, Math.round(bmp.height * scale));
    const px = this.pixels(bmp, 0, 0, bmp.width, bmp.height, 0, 0, dw, dh, S, S);
    const out = await this.faces.run({ pixels: this.tensor(px, S, S) });

    const dets = [];
    for (const stride of [8, 16, 32]) {
      const cols = S / stride;
      const cls = out[`cls_${stride}`].data;
      const obj = out[`obj_${stride}`].data;
      const box = out[`bbox_${stride}`].data;
      for (let i = 0; i < cls.length; i++) {
        const score = Math.sqrt(clamp(cls[i], 0, 1) * clamp(obj[i], 0, 1));
        if (score < c.scoreThreshold) continue;
        const row = (i / cols) | 0;
        const col = i - row * cols;
        const cx = (col + box[i * 4]) * stride;
        const cy = (row + box[i * 4 + 1]) * stride;
        const w = Math.exp(box[i * 4 + 2]) * stride;
        const h = Math.exp(box[i * 4 + 3]) * stride;
        dets.push({
          x0: (cx - w / 2) / scale,
          y0: (cy - h / 2) / scale,
          x1: (cx + w / 2) / scale,
          y1: (cy + h / 2) / scale,
          score,
        });
      }
    }
    return nms(dets, c.nmsThreshold);
  }

  /** P(female) for one face: TinyCLIP-39M face prompts + OpenVINO gender net, fused in logit space. */
  async faceFemale(bmp, d) {
    const { stage2: clip, gender } = CONFIG.models;
    const side = Math.max(d.x1 - d.x0, d.y1 - d.y0);
    const cx = (d.x0 + d.x1) / 2;
    const cy = (d.y0 + d.y1) / 2;
    const crop = (context, size) => {
      const s = side * context;
      return this.pixels(bmp, cx - s / 2, cy - s / 2, s, s, 0, 0, size, size, size, size);
    };
    const a = await this.stage2Session.run({ pixels: this.tensor(crop(clip.faceContext, clip.faceSize), clip.faceSize, clip.faceSize) }, ['face']);
    const b = await this.gender.run({ pixels: this.tensor(crop(gender.context, gender.size), gender.size, gender.size) });
    const w = CONFIG.faceFusion.clipWeight;
    return sigmoid(w * logit(a.face.data[0]) + (1 - w) * logit(b.gender.data[0]));
  }

  /** P(NSFW) for one region, squashed to the classifier's square input. */
  async nsfwScore(bmp, r) {
    const size = CONFIG.models.nsfw.size;
    const px = this.pixels(bmp, r.x, r.y, r.w, r.h, 0, 0, size, size, size, size);
    const out = await this.nsfw.run({ pixels: this.tensor(px, size, size) }, ['nsfw']);
    return out.nsfw.data[0];
  }

  /** Phase 1 of the cascade (fast). Returns { s1, region, ms }. */
  async runStage1(bmp, { quality = 'high' } = {}) {
    this.quality = quality;
    const t0 = performance.now();
    const { scores, region } = await this.stage1(bmp);
    return { s1: scores, region, ms: performance.now() - t0 };
  }

  /**
   * Phase 2 of the cascade (accurate), on the region Stage 1 picked. `need` says which parts to
   * run: the women / men check (whole image + faces; face checks are skipped when the whole-image
   * verdict is already unambiguous) and/or the NSFW check. Returns only the parts that ran.
   */
  async runStage2(bmp, s1, region, { need = { gender: true, nsfw: false }, debug = false, quality = 'high' } = {}) {
    this.quality = quality;
    const t0 = performance.now();
    const r = region ?? { x: 0, y: 0, w: bmp.width, h: bmp.height };
    const s2 = {};
    if (need.nsfw) s2.n = await this.nsfwScore(bmp, r);
    if (!need.gender) return { s2, faces: 0, ms: performance.now() - t0 };
    const img = await this.wholeImage(this.stage2Session, CONFIG.models.stage2.size, bmp, r.x, r.y, r.w, r.h);
    const skip = CONFIG.faceSkip;
    const k = Math.sqrt(Math.max(0, s1.p));
    const certain = !debug && Math.max(img.f, img.m) * k >= skip.decisive && Math.min(img.f, img.m) * k < skip.other;
    let faces = 0;
    const scored = [];
    if (!certain) {
      const dets = await this.detectFaces(bmp);
      faces = dets.length;
      const top = dets
        .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))
        .slice(0, CONFIG.models.faces.maxFaces);
      for (const d of top) scored.push({ score: d.score, female: await this.faceFemale(bmp, d) });
    }
    const out = { s2: Object.assign(s2, fuse(img, scored, s1)), faces, ms: performance.now() - t0 };
    if (debug) Object.assign(out, { img, faceScores: scored });
    return out;
  }

  /**
   * Full cascade for one image (inline executor and calibration harness).
   * @param opts.sel     user selection (see policy.selectionOf)
   * @param opts.s1      Stage 1 scores already known from the cache (skips Stage 1)
   * @param opts.s2      Stage 2 parts already known from the cache (only the missing ones run)
   * @param opts.aspect  width / height of the original image
   * @param opts.debug   always run the women / men check and return per-face scores (calibration only)
   */
  async analyze(bmp, { sel, s1: known = null, s2: known2 = null, aspect = bmp.width / bmp.height, debug = false, quality = 'high' }) {
    let s1 = known;
    let region = null;
    let ms1 = 0;
    if (!s1) ({ s1, region, ms: ms1 } = await this.runStage1(bmp, { quality }));
    const result = { s1, s2: known2, faces: 0, aspect, ms: { s1: ms1, s2: 0 } };
    const need = debug ? { gender: true, nsfw: !!sel?.n } : stage2Parts(s1, sel, known2);
    if (need) {
      const r2 = await this.runStage2(bmp, s1, region, { need, debug, quality });
      Object.assign(result, r2, { s2: { ...known2, ...r2.s2 }, ms: { s1: ms1, s2: r2.ms } });
    }
    return result;
  }
}

/**
 * Final scores: Stage 2 whole-image scores fused with per-face genders, scaled by how sure
 * Stage 1 was that a person is there at all (two models must agree before an image is blurred,
 * which removes most false alarms on people-free pictures). Weights chosen on held-out images.
 */
export function fuse(img, faces, s1) {
  let f = img.f;
  let m = img.m;
  let p = img.p;
  if (faces.length) {
    let ff = 0;
    let fm = 0;
    for (const face of faces) {
      ff = Math.max(ff, face.female * face.score);
      fm = Math.max(fm, (1 - face.female) * face.score);
      p = Math.max(p, face.score);
    }
    const w = CONFIG.fusion.stage2Weight;
    f = w * f + (1 - w) * ff;
    m = w * m + (1 - w) * fm;
  }
  const k = Math.pow(Math.max(0, s1.p), CONFIG.fusion.stage1Agreement);
  return { f: f * k, m: m * k, p };
}

function nms(dets, threshold) {
  dets.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const d of dets) {
    if (keep.every((k) => iou(k, d) <= threshold)) keep.push(d);
  }
  return keep;
}

function iou(a, b) {
  const iw = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const ih = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = iw * ih;
  const union = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - inter;
  return union > 0 ? inter / union : 0;
}
