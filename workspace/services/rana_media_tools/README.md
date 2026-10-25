# Rana Media Tools

Local media preprocessing for Rana.

This folder is intentionally a sidecar, not part of the music playback pipeline.

## Current install

`claude-real-video` is installed in the local virtual environment:

```powershell
python -m venv .\.venv
.\.venv\Scripts\python.exe -m pip install -r .\requirements.txt
```

CLI entrypoints:

```powershell
.\.venv\Scripts\crv.exe --help
.\.venv\Scripts\claude-real-video.exe --help
.\.venv\Scripts\python.exe .\analyze_media.py <attachment> --output <directory>
```

## Boundary

`claude-real-video` can preprocess videos into:

* scene-aware keyframes
* optional grids
* a `MANIFEST.txt`

`analyze_media.py` is the production wrapper used by `rana-vision`. It supports:

* video frame and grid extraction for Vision analysis;
* PDF text extraction;
* bounded text, Markdown, JSON, CSV, YAML, XML, and log reading.

Audio understanding is intentionally outside this release. Video audio is not
transcribed, and audio-only attachments do not enter this pipeline.

## LRC tools relationship

The wrapper follows this pattern:

1. extract media locally;
2. write inspectable artifacts;
3. produce a compact manifest;
4. only then let the LLM answer.
