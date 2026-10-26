// Turns model scores into blur decisions. Shared by the content script (final decision)
// and the inference engine (deciding what Stage 2 has to compute).
//
// Scores are image-level probabilities { f: female, m: male, p: any person, n: NSFW }.
//   s1 = Stage 1 (fast model): only used to reject pictures with nobody in them.
//   s2 = Stage 2 (accurate models): women / men (whole image + faces) and nudity. Each part is
//        only computed when the user's selection needs it, so s2 may hold either or both.
// Thresholds come from models/config.json (calibrated by scripts/models/calibrate.py).
import CONFIG from '../models/config.json';

export { CONFIG };

export const BLUR = 'blur';
export const CLEAN = 'clean';

/** The parts of the user settings that change what counts as a match. */
export function selectionOf(settings) {
  return {
    f: !!settings.blurFemale,
    m: !!settings.blurMale,
    n: !!settings.blurNudity,
    u: !!settings.blurUnknown,
    level: CONFIG.sensitivity[settings.sensitivity] ? settings.sensitivity : 'balanced',
  };
}

/**
 * Cascade routing: Stage 1 only answers "is anybody in this picture?" (wide banners are checked
 * tile by tile). Pictures that may contain a person go to Stage 2.
 */
export function needsStage2(s1, sel) {
  if (!sel.f && !sel.m && !sel.n) return false;
  return s1.p >= CONFIG.cascade.reject;
}

/**
 * The Stage 2 parts `sel` needs that `s2` (e.g. from the cache) does not hold yet:
 * { gender, nsfw } with at least one of them true, or null when nothing is missing.
 */
export function stage2Parts(s1, sel, s2 = null) {
  if (!needsStage2(s1, sel)) return null;
  const gender = (sel.f || sel.m) && s2?.f === undefined;
  const nsfw = sel.n && s2?.n === undefined;
  return gender || nsfw ? { gender, nsfw } : null;
}

/** Final decision for one image. `result` = { s1, s2 } as produced by the engine. */
export function decide(result, sel) {
  const s = result?.s2;
  if (!s) return CLEAN; // Stage 1 found nobody in the picture (or nothing is selected)
  // Nudity is blurred whoever is in the picture.
  if (sel.n && s.n >= CONFIG.models.nsfw.threshold) return BLUR;
  if (!sel.f && !sel.m) return CLEAN;
  const t = CONFIG.sensitivity[sel.level] ?? CONFIG.sensitivity.balanced;
  if (sel.f && s.f >= t.female) return BLUR;
  if (sel.m && s.m >= t.male) return BLUR;
  if (sel.u && s.p >= t.person) {
    // A person is clearly visible: it stays visible only if it is confidently a non-selected gender.
    const explained = (!sel.f && s.f >= CONFIG.explain.female) || (!sel.m && s.m >= CONFIG.explain.male);
    if (!explained) return BLUR;
  }
  return CLEAN;
}

/** True when this result cannot decide for `sel` yet (a Stage 2 part it needs has not run). */
export function isIncomplete(result, sel) {
  return !!result?.s1 && !!stage2Parts(result.s1, sel, result.s2);
}
