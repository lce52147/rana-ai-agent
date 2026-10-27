"""Export the sidecar CCIP reference bank (references/ccip-bank.json) from eval/ccip_dctest_v1.npz.

  python ccip_bank_export.py [--feats ../eval/ccip_dctest_v1.npz] [--out ../references/ccip-bank.json]

Only faces from frames with exactly one label and exactly one detected face go into the bank,
so every bank feature belongs to the labelled character. Faces in eval/ccip_dctest_other_v1.npz (when present)
are added as the "_other" class: side characters the sidecar must not name. Needs numpy only."""
import argparse, base64, hashlib, json, pathlib
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent

ap = argparse.ArgumentParser()
ap.add_argument("--feats", default=str(HERE.parent / "eval" / "ccip_dctest_v1.npz"))
ap.add_argument("--other", default=str(HERE.parent / "eval" / "ccip_dctest_other_v1.npz"))
ap.add_argument("--out", default=str(HERE.parent / "references" / "ccip-bank.json"))
args = ap.parse_args()

d = np.load(args.feats)
feats, rows = d["feats"].astype("<f4"), json.loads(str(d["rows"]))
keep = [i for i, r in enumerate(rows) if len(r["labels"]) == 1 and r["n_faces"] == 1]
items = [{"id": rows[i]["labels"][0], "shot_group": rows[i]["shot_group"], "series": rows[i]["path"].split("/")[0],
          "feature": base64.b64encode(feats[i].tobytes()).decode()} for i in keep]
blobs = [feats[i].tobytes() for i in keep]
if pathlib.Path(args.other).exists():
    o = np.load(args.other)
    ofeats, orows = o["feats"].astype("<f4"), json.loads(str(o["rows"]))
    for f, r in zip(ofeats, orows):
        items.append({"id": "_other", "shot_group": r["shot_group"], "series": r["path"].split("/")[0],
                      "feature": base64.b64encode(f.tobytes()).decode()})
        blobs.append(f.tobytes())
digest = hashlib.sha256(b"".join(blobs)).hexdigest()[:16]
bank = {"schema": "rana.identity.ccip-bank.v1", "version": f"dctest-{digest}", "model": "ccip-caformer-24-randaug-pruned",
        "dimension": int(feats.shape[1]), "source": "DCTEST hand labels (single label, single face) + _other side-character faces", "items": items}
out = pathlib.Path(args.out)
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(bank, ensure_ascii=False), encoding="utf-8")
print("bank", bank["version"], len(items), "items ->", out)
