#!/usr/bin/env python3
"""
Build a local full Rana dialogue corpus from ci-ke/BangDream-story.

This script does not download the repository. Point --repo at the existing
checkout. It scans story_tw and story_jp, extracts every speaker line whose
speaker label contains 樂奈 or 楽奈, and writes:

- Rana_Dialogue_Corpus.jsonl
- Rana_All_Scene_Index.md
- Rana_Self_Introduction_Evidence.md
- Rana_Speech_Stats.json
- Rana_Corpus_Manifest.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Iterable

DIALOGUE_RE = re.compile(r"^(?P<speaker>[^：:\n]{1,50})[：:](?P<text>.*)$")
RANA_NAMES = ("樂奈", "楽奈")
SCENE_RE = re.compile(r"^【(.+?)】$")
TITLE_RE = re.compile(r"^[^：:]{0,80}(?:自我介紹|自己紹介|名字|名前|叫什麼|你是誰|誰\?)")
SELF_INTRO_TERMS = (
    "自我介紹", "自己紹介", "名字", "名前", "要樂奈", "要楽奈",
    "吉他手", "ギター", "你是誰", "誰？", "叫什麼"
)

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

def category_for(path: Path) -> str:
    parts = set(path.parts)
    for category in ("band", "event", "card", "area"):
        if category in parts:
            return category
    return "other"

def language_for(path: Path) -> str:
    return "ja" if "story_jp" in path.parts else "zh-TW"

def iter_text_files(repo: Path) -> Iterable[Path]:
    for root_name in ("story_tw", "story_jp"):
        root = repo / root_name
        if not root.exists():
            continue
        for category in ("band", "event", "card", "area"):
            cat = root / category
            if cat.exists():
                yield from sorted(cat.rglob("*.txt"))

def is_rana_speaker(speaker: str) -> bool:
    return any(name in speaker for name in RANA_NAMES)

def nearby_dialogue(lines: list[str], index: int, direction: int, limit: int = 3) -> list[str]:
    out: list[str] = []
    i = index + direction
    while 0 <= i < len(lines) and len(out) < limit:
        line = lines[i].strip()
        if DIALOGUE_RE.match(line):
            out.append(line)
        i += direction
    if direction < 0:
        out.reverse()
    return out

def nearest_scene(lines: list[str], index: int) -> str:
    for i in range(index, -1, -1):
        m = SCENE_RE.match(lines[i].strip())
        if m:
            return m.group(1)
    return ""

def parse_file(path: Path, repo: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8", errors="replace")
    lines = text.splitlines()
    records: list[dict] = []
    for i, raw in enumerate(lines):
        line = raw.strip()
        m = DIALOGUE_RE.match(line)
        if not m or not is_rana_speaker(m.group("speaker")):
            continue
        records.append({
            "source_path": path.relative_to(repo).as_posix(),
            "source_sha256": sha256_file(path),
            "language": language_for(path),
            "category": category_for(path),
            "file_title": lines[0].strip() if lines else path.stem,
            "scene": nearest_scene(lines, i),
            "line_number": i + 1,
            "speaker": m.group("speaker").strip(),
            "text": m.group("text").strip(),
            "context_before": nearby_dialogue(lines, i, -1),
            "context_after": nearby_dialogue(lines, i, 1),
        })
    return records

def write_jsonl(path: Path, records: list[dict]) -> None:
    with path.open("w", encoding="utf-8", newline="\n") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

def write_index(path: Path, records: list[dict]) -> None:
    by_file: dict[str, list[dict]] = defaultdict(list)
    for record in records:
        by_file[record["source_path"]].append(record)

    category_counts = Counter(r["category"] for r in records)
    file_category_counts = Counter(
        next(iter(items))["category"] for items in by_file.values()
    )

    lines = [
        "# Rana All Scene Index",
        "",
        f"- matched files: {len(by_file)}",
        f"- dialogue lines: {len(records)}",
        "",
        "## Category totals",
        "",
        "| category | files | Rana lines |",
        "|---|---:|---:|",
    ]
    for category in sorted(set(category_counts) | set(file_category_counts)):
        lines.append(
            f"| {category} | {file_category_counts[category]} | {category_counts[category]} |"
        )

    lines.extend(["", "## Files", ""])
    for source_path, items in sorted(by_file.items()):
        scenes = sorted({item["scene"] for item in items if item["scene"]})
        scene_text = " / ".join(scenes[:5])
        if len(scenes) > 5:
            scene_text += " / …"
        lines.append(
            f"- `{source_path}` — {len(items)} lines"
            + (f" — {scene_text}" if scene_text else "")
        )
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

def write_self_intro(path: Path, records: list[dict]) -> None:
    selected = []
    for record in records:
        haystack = " ".join([
            record["file_title"],
            record["scene"],
            record["text"],
            *record["context_before"],
            *record["context_after"],
        ])
        if any(term in haystack for term in SELF_INTRO_TERMS):
            selected.append(record)

    lines = [
        "# Rana Self-Introduction Evidence",
        "",
        f"Matched dialogue lines with self-identification context: {len(selected)}",
        "",
        "This file is generated locally from the story repository.",
        "",
    ]
    for record in selected:
        lines.extend([
            f"## {record['source_path']}:{record['line_number']}",
            "",
            f"- scene: {record['scene'] or '(none)'}",
            f"- speaker: {record['speaker']}",
            f"- text: {record['text']}",
            "- context:",
        ])
        for ctx in record["context_before"]:
            lines.append(f"  - {ctx}")
        lines.append(f"  - **{record['speaker']}：{record['text']}**")
        for ctx in record["context_after"]:
            lines.append(f"  - {ctx}")
        lines.append("")
    path.write_text("\n".join(lines), encoding="utf-8")

def write_stats(path: Path, records: list[dict], file_count: int) -> None:
    lengths = [len(r["text"]) for r in records]
    first_fragments = Counter()
    for r in records:
        first = re.split(r"[，。！？…、\s]", r["text"], maxsplit=1)[0]
        if first:
            first_fragments[first] += 1
    stats = {
        "matched_files": file_count,
        "dialogue_lines": len(records),
        "category_lines": dict(Counter(r["category"] for r in records)),
        "language_lines": dict(Counter(r["language"] for r in records)),
        "length_chars": {
            "min": min(lengths) if lengths else 0,
            "max": max(lengths) if lengths else 0,
            "mean": statistics.mean(lengths) if lengths else 0,
            "median": statistics.median(lengths) if lengths else 0,
        },
        "top_first_fragments": first_fragments.most_common(50),
    }
    path.write_text(json.dumps(stats, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("generated/rana-dialogue-corpus"))
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--expected-files", type=int, default=88)
    args = parser.parse_args()

    repo = args.repo.resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)

    records: list[dict] = []
    matched_files: set[str] = set()
    scanned_files = 0

    for path in iter_text_files(repo):
        scanned_files += 1
        file_records = parse_file(path, repo)
        if file_records:
            matched_files.add(file_records[0]["source_path"])
            records.extend(file_records)

    records.sort(key=lambda r: (r["source_path"], r["line_number"]))

    write_jsonl(out / "Rana_Dialogue_Corpus.jsonl", records)
    write_index(out / "Rana_All_Scene_Index.md", records)
    write_self_intro(out / "Rana_Self_Introduction_Evidence.md", records)
    write_stats(out / "Rana_Speech_Stats.json", records, len(matched_files))

    manifest = {
        "repo": str(repo),
        "scanned_text_files": scanned_files,
        "matched_files": len(matched_files),
        "dialogue_lines": len(records),
        "expected_files": args.expected_files,
        "files": sorted(matched_files),
    }
    (out / "Rana_Corpus_Manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(json.dumps(manifest, ensure_ascii=False, indent=2))

    if args.strict and len(matched_files) < args.expected_files:
        raise SystemExit(
            f"Corpus incomplete: matched {len(matched_files)} files, "
            f"expected at least {args.expected_files}."
        )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
