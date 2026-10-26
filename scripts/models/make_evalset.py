"""Download the small labelled photo set used to calibrate thresholds (evaluation only, no training).

Picks Open Images V7 *validation* photos (CC BY 2.0) whose people all have a known gender:
130 women-only, 130 men-only, 60 mixed and 130 without any person, plus ~430 people-free web
graphics (logos, charts, diagrams, maps, screenshots, icons...) from Wikimedia Commons; ~90 MB.
A few Commons screenshots contain small photos of people; for a clean set, look through the
"graphic" images and delete those before calibrating.

    python scripts/models/make_evalset.py [--out .model-cache/evalset]
    node test/collect-scores.mjs --images .model-cache/evalset --out .model-cache/scores.json
    python scripts/models/calibrate.py --scores .model-cache/scores.json --labels .model-cache/evalset/labels.json --write
"""
import argparse
import concurrent.futures as cf
import csv
import io
import json
import os
import random
import urllib.parse
import urllib.request
from collections import defaultdict

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
META = "https://storage.googleapis.com/openimages/"
MAN, BOY, WOMAN, GIRL, PERSON = "/m/04yx4", "/m/01bl7v", "/m/03bt1vf", "/m/05r655", "/m/01g317"
HUMAN = {MAN, BOY, WOMAN, GIRL, PERSON, "/m/0dzct", "/m/04hgtk", "/m/02p0tk3", "/m/0dzf4", "/m/035r7c", "/m/0k65p",
         "/m/03q69", "/m/014sv8", "/m/015h_t", "/m/0283dt1", "/m/0k0pj", "/m/039xj_", "/m/031n1"}
WANT = {"female": 130, "male": 130, "both": 60, "none": 130}
GRAPHIC_CATEGORIES = ["Logos", "Diagrams", "Charts", "Maps", "Screenshots of web browsers", "Icons", "Flags",
                      "Typography", "Patterns", "Textures", "Computer screenshots"]
UA = {"User-Agent": "NoHaramEval/1.0 (calibration set for an on-device image filter)"}


def fetch(url, path):
    if not os.path.exists(path):
        urllib.request.urlretrieve(url, path)
    return path


def iou(a, b):
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter + 1e-9)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, ".model-cache", "evalset"))
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    meta_dir = os.path.join(os.path.dirname(a.out), "oi-meta")
    os.makedirs(meta_dir, exist_ok=True)
    boxes_csv = fetch(META + "v5/validation-annotations-bbox.csv", os.path.join(meta_dir, "validation-annotations-bbox.csv"))
    rot_csv = fetch(META + "2018_04/validation/validation-images-with-rotation.csv", os.path.join(meta_dir, "validation-images-with-rotation.csv"))

    rotated = {r["ImageID"] for r in csv.DictReader(open(rot_csv, encoding="utf-8")) if float(r.get("Rotation") or 0) != 0}
    boxes, labels = defaultdict(list), defaultdict(set)
    for r in csv.DictReader(open(boxes_csv, encoding="utf-8")):
        labels[r["ImageID"]].add(r["LabelName"])
        if r["LabelName"] in (MAN, BOY, WOMAN, GIRL, PERSON):
            boxes[r["ImageID"]].append((r["LabelName"], float(r["XMin"]), float(r["YMin"]), float(r["XMax"]), float(r["YMax"])))

    pools = defaultdict(list)
    for iid, labs in labels.items():
        if iid in rotated:  # stored sideways on S3
            continue
        m, f = bool(labs & {MAN, BOY}), bool(labs & {WOMAN, GIRL})
        gendered = [b[1:] for b in boxes[iid] if b[0] != PERSON]
        unknown = [b for b in boxes[iid] if b[0] == PERSON and all(iou(b[1:], g) < 0.5 for g in gendered)]
        if not labs & HUMAN:
            pools["none"].append(iid)
        elif unknown:
            continue  # people of unknown gender: ambiguous ground truth
        elif m and f:
            pools["both"].append(iid)
        elif f:
            pools["female"].append(iid)
        elif m:
            pools["male"].append(iid)

    random.seed(a.seed)
    chosen = []
    for kind, n in WANT.items():
        ids = sorted(pools[kind])
        random.shuffle(ids)
        chosen += [(iid, kind) for iid in ids[:n]]

    def download(item):
        iid, _ = item
        out = os.path.join(a.out, f"{iid}.jpg")
        if not os.path.exists(out):
            from PIL import Image
            data = urllib.request.urlopen(f"https://open-images-dataset.s3.amazonaws.com/validation/{iid}.jpg", timeout=60).read()
            im = Image.open(io.BytesIO(data)).convert("RGB")
            im.thumbnail((800, 800))
            im.save(out, quality=92)

    with cf.ThreadPoolExecutor(16) as ex:
        list(ex.map(download, chosen))
    labels = {f"{iid}.jpg": kind for iid, kind in chosen}
    labels.update(download_graphics(a.out))
    with open(os.path.join(a.out, "labels.json"), "w") as f:
        json.dump(labels, f, indent=1)
    print(f"{len(labels)} images in {a.out}")


def download_graphics(out):
    """People-free web graphics from Wikimedia Commons categories (polite: one request at a time)."""
    import time
    from PIL import Image
    labels = {}
    for cat in GRAPHIC_CATEGORIES:
        time.sleep(3)
        q = urllib.parse.urlencode({"action": "query", "generator": "categorymembers", "gcmtitle": f"Category:{cat}",
                                    "gcmtype": "file", "gcmlimit": 40, "prop": "imageinfo", "iiprop": "url|mime",
                                    "iiurlwidth": 480, "format": "json"})
        try:
            req = urllib.request.Request("https://commons.wikimedia.org/w/api.php?" + q, headers=UA)
            pages = json.load(urllib.request.urlopen(req, timeout=30)).get("query", {}).get("pages", {}).values()
        except Exception as e:  # noqa: BLE001
            print(f"  {cat}: {e}")
            continue
        for n, p in enumerate(pages):
            info = (p.get("imageinfo") or [{}])[0]
            url = info.get("thumburl")
            if not url or not info.get("mime", "").startswith("image/"):
                continue
            name = f"gfx_{cat.replace(' ', '_')}_{n}.jpg"
            path = os.path.join(out, name)
            try:
                if not os.path.exists(path):
                    time.sleep(0.7)
                    data = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read()
                    im = Image.open(io.BytesIO(data)).convert("RGB")
                    if min(im.size) < 64:
                        continue
                    im.save(path, quality=92)
                labels[name] = "graphic"
            except Exception:  # noqa: BLE001
                continue
    return labels


if __name__ == "__main__":
    main()
