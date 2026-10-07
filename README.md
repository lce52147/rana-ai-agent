# Rana AI Agent

Rana is a personal, local-first AI agent project built around OpenClaw.

The project started from a simple question: how far can a character-oriented agent be pushed beyond a single system prompt while still keeping its behavior, knowledge boundaries, tool use, and long-running context coherent?

It is an ongoing hobby and research project rather than a turnkey chatbot product. The repository contains the runtime extensions, persona/lore structure, tool integrations, regression tests, and research notes used to explore that question.

> **Status:** active development. Interfaces, routing rules, and corpus structure may change as experiments are replaced by better ones.

## What this project explores

Rana is mainly used to experiment with several problems that become visible once an agent is expected to run for a long time instead of answering isolated prompts:

- **Persona consistency** — keeping generation behavior stable without injecting an entire research corpus into every prompt.
- **Knowledge boundaries** — separating canonical facts, retrieved evidence, memories, assumptions, and generation style.
- **Turn isolation** — preventing stale context or a previous tool result from silently becoming authority for the current turn.
- **Tool/action routing** — deciding when an external action is justified by the current user intent and when the agent should fail closed.
- **Retrieval-grounded lore** — retrieving only the relevant parts of a larger source-audited corpus instead of treating all notes as runtime truth.
- **Local-first inference** — keeping the system usable with local model backends while allowing the surrounding architecture to remain model-agnostic.
- **Multimodal and media workflows** — vision, music, web/search, playback, and supporting sidecar services.
- **Regression testing** — treating persona boundaries and tool behavior as testable contracts instead of relying only on subjective prompt tuning.

## Architecture

A simplified view of the current system is:

```text
Discord / user input
        |
        v
   OpenClaw gateway
        |
        v
+---------------------------+
|       rana-runtime        |
|---------------------------|
| turn/context projection   |
| persona projection        |
| lore retrieval            |
| provenance boundaries     |
| pre-dispatch routing      |
| tool contracts            |
| output guards             |
+---------------------------+
        |
        +------> model backend(s)
        |
        +------> tool / sidecar layer
                   |
                   +-- vision
                   +-- music / playback
                   +-- web search
                   +-- memory
                   +-- media analysis
                   +-- other local services
```

The architecture deliberately separates **research material** from **runtime material**. A source being useful for research does not automatically make it appropriate to inject into every generation turn.

## Repository layout

### `extensions/rana-runtime/`

The main runtime extension.

This is where most of the agent-side control logic lives, including context projection, turn planning, persona/lore integration, model/tool guidance, tool receipts, memory grounding, output guards, and regression tests.

### `extensions/rana-vision/`

Vision and image-related routing, evidence handling, reverse-search integration, character identity support, and related tests.

### `extensions/rana-music-tools/`

Music/playback tools and the routing layer around the music service.

### `extensions/openclaw-web-search/`

A small OpenClaw web-search extension used by the agent tool layer.

### `workspace/LORE/`

The lore/canonical-data side of the project.

It is split into different roles instead of being treated as one giant prompt:

- `runtime/` — compact material that can participate in normal runtime behavior.
- `research/` — source audits, relationship maps, interaction indexes, coverage notes, and other research material.
- deployment/generated material — supporting artifacts that are not automatically authoritative runtime facts.

### `workspace/research/`

Dialogue/source corpus work used to study speech style and source coverage.

### `workspace/services/`

Local supporting services, including music/media and hot-tool sidecars.

### `workspace/tests/` and `*.test.mjs`

Smoke prompts and regression tests for routing, persona boundaries, retrieval behavior, tool contracts, output style, vision behavior, and other runtime invariants.

## Design principles

### Research persona and generation persona are separate

Research notes can be detailed, third-person, or source-oriented. Generated dialogue should not inherit that writing style just because the evidence exists.

The runtime therefore tries to project only the information needed for the current turn.

### Current-turn intent matters

A tool being available does not mean it should be called.

The project uses current-turn contracts, pre-dispatch logic, and tool-specific guards to reduce false triggers, especially in noisy conversational environments.

### Provenance should survive retrieval

Retrieved information is useful only if the runtime still knows what kind of evidence it is.

Canonical facts, source audits, memories, tool results, and model inference are therefore not intended to be interchangeable.

### Fail closed when evidence is weak

For actions and factual claims that depend on external evidence, missing or ambiguous evidence should normally reduce confidence or prevent the action rather than silently invent authority.

### Behavioral changes need regressions

Many failures in long-lived agents are small boundary failures: a wrong tool call, a remembered fact used in the wrong context, an overly assistant-like response, or a persona rule leaking into an unrelated turn.

The repository keeps targeted regression tests for these cases so fixes can be checked against earlier behavior.

## Testing

There is no single benchmark that represents the whole project. Testing is split by subsystem and failure mode.

Examples in the repository cover areas such as:

- model selection
- turn and context isolation
- current-turn tool contracts
- persona boundaries and salience
- memory honesty
- lore/RAG retrieval
- canonical-query precedence
- output language and grammar guards
- vision routing
- music identity/routing
- control parsing
- regression replays for previously observed failures

The goal is not to prove that the agent is universally correct. The tests are used to make behavioral changes observable and to prevent known failure modes from silently returning.

## Local-first / external components

Large binaries, model weights, credentials, local databases, runtime logs, and private machine state are intentionally not committed.

See [`EXTERNAL_BINARIES.md`](EXTERNAL_BINARIES.md) for external binary notes used by the local setup.

A local installation may also depend on components such as OpenClaw, Lavalink, FFmpeg, model runtimes, and service-specific Python/Node dependencies. This repository should be read as the evolving source tree of the project, not as a one-click installer.

## Project boundaries

Rana is an unofficial personal project.

It is not affiliated with or endorsed by OpenClaw, BanG Dream!, MyGO!!!!!, or their respective rights holders. Character names and source material remain the property of their owners.

The project does not claim perfect character emulation or a solved general-purpose agent architecture. Research notes and runtime rules reflect the current state of the experiments and are revised when better evidence or a better design becomes available.

## Why keep this public?

The interesting part of the project is not a single prompt. It is the accumulated engineering around long-running agent behavior: routing, retrieval, evidence boundaries, local inference, tool orchestration, multimodal workflows, and the tests needed to keep those pieces from interfering with each other.

Keeping the implementation and research structure visible also makes it easier to inspect how those decisions evolved over time.
