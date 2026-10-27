"""Held-out check of anime face detection + CCIP character features on hand-labelled DCTEST frames.

  python ccip_eval.py extract --images <DCTEST jpg root> --index <dctest_index.json> --groups <shot_groups.json> [--out eval/ccip_dctest_v1.npz]
      detect faces on every labelled frame, one CCIP feature per padded face crop (needs the images; desktop only)
  python ccip_eval.py eval [--feats eval/ccip_dctest_v1.npz]
      (a) leave-shot-group-out kNN, (b) MyGO -> Ave Mujica, (c) Ave Mujica -> MyGO; needs only the .npz

Only faces from frames with exactly one label and exactly one detected face are scored.
Requires: pip install dghs-imgutils onnxruntime==1.20.1"""
import argparse, json, pathlib, time
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_FEATS = HERE.parent / "eval" / "ccip_dctest_v1.npz"
PAD = 0.35  # face box padding, so hair colour and accessories are in the crop


def pad_box(box, width, height, pad=PAD):
    x0, y0, x1, y1 = box
    px, py = int((x1 - x0) * pad), int((y1 - y0) * pad)
    return max(0, x0 - px), max(0, y0 - py), min(width, x1 + px), min(height, y1 + py)


def extract(args):
    from PIL import Image
    from imgutils.detect import detect_faces
    from imgutils.metrics import ccip_extract_feature
    index = json.loads(pathlib.Path(args.index).read_text(encoding="utf-8"))
    items = [i for i in (index["items"] if isinstance(index, dict) else index) if i.get("label_ids")]
    groups = json.loads(pathlib.Path(args.groups).read_text(encoding="utf-8"))
    shot = {p: g for g, grp in enumerate(groups) for p in grp["paths"]}
    rows, feats, t0 = [], [], time.time()
    for k, it in enumerate(items):
        img = Image.open(pathlib.Path(args.images) / it["path"]).convert("RGB")
        faces = [f for f in detect_faces(img) if f[2] >= 0.5]
        for box, _, score in faces:
            if min(box[2] - box[0], box[3] - box[1]) < 24:
                continue
            feats.append(ccip_extract_feature(img.crop(pad_box(box, img.width, img.height))))
            rows.append({"path": it["path"], "labels": it["label_ids"], "box": list(box), "score": float(score),
                         "n_faces": len(faces), "shot_group": shot.get(it["path"], -1)})
        if k % 100 == 0:
            print(k, len(items), len(rows), f"{time.time() - t0:.0f}s", flush=True)
    np.savez_compressed(args.out, feats=np.stack(feats).astype(np.float32), rows=json.dumps(rows, ensure_ascii=False))
    print("done", len(rows), "faces from", len(items), "frames")


def evaluate(args):
    from imgutils.metrics import ccip_batch_differences, ccip_default_threshold
    d = np.load(args.feats)
    feats, rows = d["feats"], json.loads(str(d["rows"]))
    keep = [i for i, r in enumerate(rows) if len(r["labels"]) == 1 and r["n_faces"] == 1]
    lab = [rows[i]["labels"][0] for i in keep]
    grp = [rows[i]["shot_group"] if rows[i]["shot_group"] >= 0 else -1 - n for n, i in enumerate(keep)]
    series = [rows[i]["path"].split("/")[0] for i in keep]
    D = ccip_batch_differences(list(feats[keep]))
    thr = ccip_default_threshold()
    print("samples", len(keep), "per char", {c: lab.count(c) for c in sorted(set(lab))}, "ccip threshold", round(thr, 3))
    every = range(len(keep))

    def run(name, test_idx, allowed):
        top1 = acc_n = acc_ok = 0
        conf = {}
        for i in test_idx:
            best = {}
            for j in allowed(i):
                if D[i, j] < best.get(lab[j], 9):
                    best[lab[j]] = D[i, j]
            if not best:
                continue
            ranked = sorted(best.items(), key=lambda kv: kv[1])
            pred, dist = ranked[0]
            margin = ranked[1][1] - dist if len(ranked) > 1 else 1
            top1 += pred == lab[i]
            conf.setdefault(lab[i], {}).setdefault(pred, 0)
            conf[lab[i]][pred] += 1
            if dist < thr and margin >= args.margin:
                acc_n += 1
                acc_ok += pred == lab[i]
        n = len(test_idx)
        print(f"[{name}] n={n} top1={top1}/{n} ({top1 / max(n, 1):.0%}) | accepted {acc_n}/{n} ({acc_n / max(n, 1):.0%}),"
              f" correct when accepted {acc_ok}/{acc_n} ({acc_ok / max(acc_n, 1):.0%})")
        for c in sorted(conf):
            print("   ", c, dict(sorted(conf[c].items(), key=lambda kv: -kv[1])))

    run("leave-shot-group-out", list(every), lambda i: (j for j in every if grp[j] != grp[i]))
    for train, test in (("mygo", "ave-mujica"), ("ave-mujica", "mygo")):
        known = {lab[j] for j in every if series[j] == train}
        run(f"train {train} -> test {test}", [i for i in every if series[i] == test and lab[i] in known],
            lambda i, train=train: (j for j in every if series[j] == train))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("extract")
    ex.add_argument("--images", required=True)
    ex.add_argument("--index", required=True)
    ex.add_argument("--groups", required=True)
    ex.add_argument("--out", default=str(DEFAULT_FEATS))
    ev = sub.add_parser("eval")
    ev.add_argument("--feats", default=str(DEFAULT_FEATS))
    ev.add_argument("--margin", type=float, default=0.02)
    a = ap.parse_args()
    {"extract": extract, "eval": evaluate}[a.cmd](a)
