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
- `app/identity-engine.mjs`: model loading (Xenova/clip-vit-base-patch32, q4), reference bank, open-set decisions.
- `config.example.json`: the deployed config with the key removed. The real `config.json` stays on the laptop.
- `start-sidecar.ps1` / `stop-sidecar.ps1`: run on the laptop (they use the bundled `runtime\node`).

The desktop uses it from `extensions/rana-vision`:

- `identity_sidecar_client.js` calls `/v1/identity/retrieve`.
- `scene_index.js` calls `/v1/embeddings/batch` for DCTEST meme lookup.

The DCTEST index (`vision-index/dctest_index.json`) records the model it was built with. Changing the model or dtype here means rebuilding that index.

Tests: `node --test app/unit.test.mjs app/contract.test.mjs` (no model download needed).
