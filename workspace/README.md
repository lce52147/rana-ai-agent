# v5.10 Runtime Preference Hard Gate

This is a runtime patch, not another persona Markdown release.

## Root cause

`extensions/rana-runtime/output_guard.js` currently allows any ordinary reply up to 1800 characters unless it leaks internal data, overclaims a conservative person, or violates tool-evidence contracts. Therefore long assistant-style food reviews pass unchanged.

## Files

- replace `extensions/rana-runtime/index.js`
- add `extensions/rana-runtime/preference_guard.js`
- add `extensions/rana-runtime/preference_guard.test.mjs`
- follow `CODEX_DEPLOY.md`

## Safety

- no change to gateway arguments
- no `--force`
- no broad clipping of unrelated replies
- detailed analysis requests bypass the gate
