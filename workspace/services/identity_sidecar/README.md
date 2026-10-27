# Rana identity sidecar (v3.1.0)

CPU CLIP embedding service that runs on the laptop, not on this desktop.
This folder is a copy of the deployed install at
`%LOCALAPPDATA%\RanaIdentitySidecar` on the laptop, taken on 2026-10-25.

- `app/server.mjs`: HTTP API on port 6971, bearer auth from `config.json`.
  - `/health`
  - `/v1/embeddings/batch` (up to 24 images, 512-d L2-normalized vectors)
  - `/v1/identity/retrieve`
  - `/v1/identity/index/snapshot`
  - `/v1/identity/reload`
  - `/v1/identity/faces` (whole image in, one decision per detected anime face; needs the `ccip` config block)
- `app/identity-engine.mjs`: model loading (Xenova/clip-vit-base-patch32, q4), reference bank, open-set decisions.
- `config.example.json`: the deployed config with the key removed. The real `config.json` stays on the laptop.
- `start-sidecar.ps1` / `stop-sidecar.ps1`: run on the laptop (they use the bundled `runtime\node`).

The desktop uses it from `extensions/rana-vision`:

- `identity_sidecar_client.js` calls `/v1/identity/retrieve`.
- `scene_index.js` calls `/v1/embeddings/batch` for DCTEST meme lookup.

The DCTEST index (`vision-index/dctest_index.json`) records the model it was built with. Changing the model or dtype here means rebuilding that index.

## Face identity (CCIP)

`app/ccip-engine.mjs` runs on the whole image:

1. It finds anime faces with deepghs `anime_face_detection` (`face_detect_v1.4_s`).
2. It pads each face box by 35%.
3. It turns each padded face into a CCIP feature (`ccip-caformer-24-randaug-pruned`).
4. It compares the feature with `references/ccip-bank.json` through the CCIP metric model.

A face is accepted when all three of these hold:

- its nearest bank face has a difference below 0.09;
- its 3 nearest bank faces are all the same character;
- those 3 faces come from at least 2 different shots, unless the nearest is closer than 0.03;
- the nearest character is a real one, not a bank class whose id starts with `_` (such as `_other`, which holds classmates, parents and other side characters so they are not mistaken for the main cast).

When no face is found (extreme close-ups), the whole frame is matched the same way with a stricter limit of 0.045 and returned as one `whole_frame` entry (`face_id` `W1`).

Setup on the laptop:

- Copy the three ONNX files from the deepghs Hugging Face repos into `models/ccip/` (the layout is in `CCIP_DEFAULTS`).
- Run `python tools/ccip_bank_export.py` to write `references/ccip-bank.json` from `eval/ccip_dctest_v1.npz` and `eval/ccip_dctest_other_v1.npz`.
- Add the `ccip` block from `config.example.json` to `config.json`.

`tools/ccip_eval.py` reproduces the held-out numbers. They are listed in `eval/README.md`.

Tests: `node app/unit.test.mjs && node app/contract.test.mjs && node app/ccip.unit.test.mjs` (no model download needed).
