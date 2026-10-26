"""Derive the decision thresholds in src/models/config.json from scores produced by the real
browser pipeline (test/collect-scores.mjs, which forces Stage 2 on every image) on a labelled
image set. No model is trained.

    python scripts/models/calibrate.py --scores scores.json --labels labels.json [--write]

labels.json maps file -> "female" | "male" | "both" | "none" | "graphic"
("none" = photo without people, "graphic" = logo/chart/screenshot/... without people).
"""
import argparse
import json
import os

import numpy as np

CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "models", "config.json")
TARGET_RECALL = {"relaxed": 0.85, "balanced": 0.92, "strict": 0.97}
PERSON_FP = {"relaxed": 0.01, "balanced": 0.03, "strict": 0.07}  # share of people-free images over the person threshold
STAGE1_PEOPLE_LOSS = 0.01  # Stage 1 may reject at most this share of images with people


def auc(pos, neg):
    pos, neg = np.asarray(pos), np.asarray(neg)
    return float(np.mean(pos[:, None] > neg[None, :]) + 0.5 * np.mean(pos[:, None] == neg[None, :]))


def fuse(img, faces, w, s1p=1.0, agreement=0.5):
    """Mirror of fuse() in src/engine/pipeline.js."""
    f, m, p = img["f"], img["m"], img["p"]
    if faces:
        f = w * f + (1 - w) * max(x["female"] * x["score"] for x in faces)
        m = w * m + (1 - w) * max((1 - x["female"]) * x["score"] for x in faces)
        p = max(p, max(x["score"] for x in faces))
    k = max(0.0, s1p) ** agreement
    return {"f": f * k, "m": m * k, "p": p}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--scores", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--write", action="store_true", help="update src/models/config.json")
    a = ap.parse_args()
    scores, labels = json.load(open(a.scores)), json.load(open(a.labels))
    cfg = json.load(open(CONFIG))
    ids = [k for k, v in scores.items() if v.get("img") and k in labels]
    K = {i: labels[i] for i in ids}
    POS = {"f": ("female", "both"), "m": ("male", "both")}
    OTHER = {"f": "male", "m": "female"}
    NOBODY = ("none", "graphic")
    print(f"{len(ids)} images: " + ", ".join(f"{k}={sum(v == k for v in K.values())}" for k in ("female", "male", "both", "none", "graphic")))

    # Stage 1 reject threshold: lose at most 1% of the images that contain people.
    S1 = {i: scores[i]["s1"] for i in ids}
    reject = float(np.quantile([S1[i]["p"] for i in ids if K[i] not in NOBODY], STAGE1_PEOPLE_LOSS))
    passed = {i: S1[i]["p"] >= reject for i in ids}
    wide_s1p = lambda i: S1[i]["p"]
    print(f"stage 1 reject p<{reject:.3f}: stops {np.mean([not passed[i] for i in ids if K[i] in NOBODY]):.0%} of people-free images "
          f"({np.mean([not passed[i] for i in ids if K[i] == 'graphic']):.0%} of graphics), loses {np.mean([not passed[i] for i in ids if K[i] not in NOBODY]):.1%} of people images")

    # Stage 2 fusion weight: best mean AUC.
    best = None
    for w in (0.5, 0.6, 0.7, 0.8, 0.9):
        F = {i: fuse(scores[i]["img"], scores[i].get("faceScores") or [], w, wide_s1p(i)) for i in ids}
        aucs = [auc([F[i][g] for i in ids if K[i] in POS[g]], [F[i][g] for i in ids if K[i] not in POS[g]]) for g in "fm"]
        print(f"stage2Weight={w}: female AUC {aucs[0]:.3f}  male AUC {aucs[1]:.3f}")
        if best is None or np.mean(aucs) > best[0] + 1e-4:
            best = (np.mean(aucs), w)
    w = best[1]
    F = {i: fuse(scores[i]["img"], scores[i].get("faceScores") or [], w, wide_s1p(i)) for i in ids}
    final = {i: (F[i] if passed[i] else None) for i in ids}  # None = rejected by stage 1 (never blurred)

    def fs(i, g):
        return final[i][g] if final[i] else -1.0

    sens = {}
    for level, recall in TARGET_RECALL.items():
        t = {}
        for g, name in (("f", "female"), ("m", "male")):
            pos = [fs(i, g) for i in ids if K[i] in POS[g]]
            t[name] = round(float(np.quantile(pos, 1 - recall)), 3)
        t["person"] = round(float(np.quantile([fs(i, "p") for i in ids if K[i] in NOBODY], 1 - PERSON_FP[level])), 3)
        sens[level] = t
    explain = {name: round(float(np.quantile([fs(i, g) for i in ids if K[i] in (OTHER[g], *NOBODY)], 0.95)), 3)
               for g, name in (("f", "female"), ("m", "male"))}

    def decide(i, sel_f, sel_m, unknown, t):
        s = final[i]
        if not s:
            return False
        if sel_f and s["f"] >= t["female"]:
            return True
        if sel_m and s["m"] >= t["male"]:
            return True
        if unknown and s["p"] >= t["person"]:
            explained = (not sel_f and s["f"] >= explain["female"]) or (not sel_m and s["m"] >= explain["male"])
            return not explained
        return False

    print("\nlevel     blur    caught  other-gender-only  people-free photos  graphics   (unknown rule on)")
    for level, t in sens.items():
        for g, name in (("f", "women"), ("m", "men")):
            sf, sm = g == "f", g == "m"
            rate = lambda grp: np.mean([decide(i, sf, sm, True, t) for i in ids if K[i] in grp])
            print(f"{level:9s} {name:6s}  {rate(POS[g]):.0%}     {rate((OTHER[g],)):.0%}                {rate(('none',)):.0%}                 {rate(('graphic',)):.0%}")
    print(f"\nstage 2 runs on {np.mean([passed[i] for i in ids if K[i] in NOBODY]):.0%} of people-free images")

    if a.write:
        cfg["fusion"]["stage2Weight"] = w
        cfg["cascade"]["reject"] = round(reject, 3)
        cfg["sensitivity"] = sens
        cfg["explain"] = explain
        counts = {k: sum(v == k for v in K.values()) for k in ("female", "male", "both", "none", "graphic")}
        cfg["calibration"] = (f"scripts/models/calibrate.py on the browser pipeline's own scores for {len(ids)} images "
                              f"({counts['female']} women-only, {counts['male']} men-only, {counts['both']} mixed, "
                              f"{counts['none']} photos and {counts['graphic']} graphics without people). "
                              "Balanced = 92% of images with the selected gender blurred.")
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=2)
            f.write("\n")
        print("updated", os.path.relpath(CONFIG))


if __name__ == "__main__":
    main()
