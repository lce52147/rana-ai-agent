from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


TEXT_EXTENSIONS = {".txt", ".log", ".md", ".csv", ".json", ".yaml", ".yml", ".xml"}
VIDEO_EXTENSIONS = {".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v"}


def read_text(path: Path, limit: int = 120_000) -> str:
    raw = path.read_bytes()[: limit * 4]
    for encoding in ("utf-8-sig", "utf-16", "cp950", "shift_jis", "latin1"):
        try:
            return raw.decode(encoding)[:limit]
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")[:limit]


def pdf_text(path: Path, limit: int = 120_000) -> tuple[str, int]:
    import fitz

    document = fitz.open(path)
    chunks: list[str] = []
    total = 0
    for page in document:
        text = page.get_text("text")
        chunks.append(text)
        total += len(text)
        if total >= limit:
            break
    return "\n".join(chunks)[:limit], document.page_count


def media_probe(path: Path) -> dict:
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return {}
    command = [
        ffprobe,
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        str(path),
    ]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=30)
    if completed.returncode != 0:
        return {}
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError:
        return {}


def analyze_video(path: Path, output: Path, max_frames: int) -> dict:
    crv = Path(sys.executable).with_name("crv.exe")
    if not crv.exists():
        raise RuntimeError(f"CRV executable not found: {crv}")
    output.mkdir(parents=True, exist_ok=True)
    command = [
        str(crv),
        str(path),
        "-o",
        str(output),
        "--scene",
        "0.30",
        "--fps-floor",
        "4.0",
        "--max-frames",
        str(max_frames),
        "--dedup-threshold",
        "8",
        "--dedup-window",
        "4",
        "--grid",
        "--no-transcribe",
    ]
    child_env = {
        **os.environ,
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    completed = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
        env=child_env,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "CRV failed")[-4000:])

    frames = sorted((output / "frames").glob("frame_*.jpg"))
    grids = sorted((output / "grids").glob("grid_*.jpg"))
    manifest_path = output / "MANIFEST.txt"
    return {
        "status": "ok",
        "kind": "video",
        "source": str(path),
        "output_dir": str(output),
        "manifest": read_text(manifest_path, 20_000) if manifest_path.exists() else "",
        "frames": [str(item) for item in frames],
        "grids": [str(item) for item in grids],
        "probe": media_probe(path),
        "crv_stdout": completed.stdout[-4000:],
    }


def analyze(path: Path, output: Path, max_frames: int) -> dict:
    extension = path.suffix.lower()
    if extension in VIDEO_EXTENSIONS:
        return analyze_video(path, output, max_frames)
    if extension == ".pdf":
        text, pages = pdf_text(path)
        return {
            "status": "ok",
            "kind": "pdf",
            "source": str(path),
            "pages": pages,
            "text": text,
        }
    if extension in TEXT_EXTENSIONS:
        return {
            "status": "ok",
            "kind": "text",
            "source": str(path),
            "text": read_text(path),
        }
    raise RuntimeError(f"unsupported attachment type: {extension or 'unknown'}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-frames", type=int, default=18)
    args = parser.parse_args()

    source = Path(args.source).resolve()
    output = Path(args.output).resolve()
    if not source.is_file():
        print(json.dumps({"status": "error", "error": "source file not found"}, ensure_ascii=True))
        return 2
    try:
        result = analyze(source, output, max(3, min(args.max_frames, 36)))
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except Exception as error:
        print(json.dumps({"status": "error", "error": str(error), "source": str(source)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
