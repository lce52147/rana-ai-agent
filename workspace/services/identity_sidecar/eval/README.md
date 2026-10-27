# CCIP face-feature evaluation data

`ccip_dctest_v1.npz` holds features only, no images.

- `feats`: 1893 × 768 float32 CCIP features (deepghs `ccip-caformer-24-randaug-pruned`, via `dghs-imgutils` 0.19.0).
  - Each feature comes from one anime face crop.
  - The face box comes from `imgutils.detect.detect_faces`, score ≥ 0.5, and is padded 35% on each side.
  - The crops were taken from 1465 hand-labelled DCTEST frames.
- `rows`: JSON list, one entry per feature, with these fields:
  - `path`: the frame's DCTEST path, which is the series plus the subtitle line.
  - `labels`: the characters labelled on the whole frame.
  - `box`, `score`, and `n_faces`.
  - `shot_group`: frames with cosine ≥ 0.95 belong to the same shot.

The DCTEST frames themselves stay on the desktop and are not published. Run the evaluation with `python ../tools/ccip_eval.py eval`.

Result on 2026-10-25 (880 single-label, single-face samples):

| Test | top-1 | accepted | correct when accepted |
|---|---|---|---|
| Leave-shot-group-out | 97% | 93% | 98% |
| MyGO → Ave Mujica | 95% | 90% | 98% |
| Ave Mujica → MyGO | 98% | 92% | 99% |

"Accepted" means the CCIP difference is below the default threshold (0.178) and the margin over the second-best character is at least 0.02. For comparison, the current CLIP B/32 whole-frame kNN scored 65%.

## Side characters and the tiered check

`ccip_dctest_other_v1.npz` holds 64 faces of side characters (classmates, parents, staff, RiNG staff), picked by eye from 1020 faces in 834 shot groups that are not in the bank. `rows` keep `path`, `shot_group` and `box`. The bank export adds them as `_other`, and a face nearest to `_other` is never named.

The gate was then checked blind on two samples of 60 DCTEST shots outside the bank. Each visible person was graded first as C (clear face), B (unclear: side view, dark, small) or A (nearly unrecognisable), and only then compared with the sidecar's answer. The second sample came from shot groups held out of both the `_other` picking and the first sample. With the current gate (0.09, `_other`, single shot below 0.03, whole frame below 0.045):

| Second sample | right | "unknown" | wrong |
|---|---|---|---|
| C, main cast | 22 | 1 | 0 |
| B, main cast | 20 | 4 | 0 |
| Side characters | 3 | – | 1 |
