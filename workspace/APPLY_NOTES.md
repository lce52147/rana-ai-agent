# APPLY_NOTES — v5.7 MD routing guards

v5.7 supersedes v5.6.

This release intentionally changes Markdown only.  
It does not modify the JavaScript tool router, OpenClaw extension code, hot-tools server, or gateway process.

## Replace Core files

- AGENTS.md
- SOUL.md
- TOOLS.md
- IDENTITY.md
- USER.md
- MEMORY.md
- HEARTBEAT.md
- BOOTSTRAP.md

## Replace/add production memory files

- `memory/rana_people_remembered.md`
- `memory/rana_people_limited.md`
- `memory/rana_people_boundaries.md`
- `memory/rana_places_events.md`
- `memory/rana_birthdays.md`
- `memory/rana_profile.md`

Delete or quarantine older duplicate Rana relationship files used by retrieval.

## Main changes

### Stock tool MD guard

`rana_stock_research` now requires both:

1. explicit finance/stock semantics;
2. a stock target or an explicit request for stock candidates.

Generic verbs such as `查`、`看`、`找` and numbers such as `11` are not stock intent.

The stock failure sentence may appear only after a valid stock request and an actual failed stock call.

### Canonical name normalization

Production Traditional Chinese output now uses:

- full name: `祐天寺若麥`
- short name: `若麥`

The following are input aliases for the same person:

- `祐天寺にゃむ`
- `にゃむ`
- `Nyamu`
- `喵夢`
- `Amoris`

Do not create a second `喵夢` entity and do not store the alias mapping as a newly learned character fact.

## Deployment

1. Replace the listed Core and memory MD files.
2. Reload the OpenClaw configuration.
3. Start a fresh Discord session.
4. Run `tests/v5_7_md_routing_alias_tests.md`.
5. Inspect tool-selection traces.

Because this is an MD-only release, PASS means the model obeys the prompt-level gate.  
If the extension pre-router itself still forces stock handling before the model sees the message, that is a separate runtime-code failure and this package does not alter it.
