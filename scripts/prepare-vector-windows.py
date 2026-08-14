#!/usr/bin/env python3
"""Build Rav-centered retrieval windows for the Cloudflare Vectorize backend.

Each vector is centered on one top-level Rav Rosenfeld message. Nearby Participant
messages are included as conversational context, but only Rav Rosenfeld messages are
authoritative. The source text is kept below Vectorize's 10 KiB metadata limit.
"""
from pathlib import Path
import datetime
import json
import re
import sys
import zipfile

BEFORE_MESSAGES = 5
AFTER_MESSAGES = 2
MAX_SOURCE_BYTES = 9000


def find_default_zip() -> Path:
    candidates = sorted(Path("private-input").glob("*.zip"))
    if not candidates:
        raise SystemExit("No WhatsApp ZIP found in private-input/")
    return candidates[0].resolve()


src = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else find_default_zip()
out_path = (
    Path(sys.argv[2]).expanduser().resolve()
    if len(sys.argv) > 2
    else Path("build/vector-windows.jsonl").resolve()
)

if src.suffix.lower() == ".zip":
    with zipfile.ZipFile(src) as archive:
        candidates = [name for name in archive.namelist() if name.lower().endswith(".txt")]
        if not candidates:
            raise SystemExit("No .txt WhatsApp export found inside the ZIP")
        text = archive.read(candidates[0]).decode("utf-8-sig", errors="replace")
else:
    text = src.read_text(encoding="utf-8-sig", errors="replace")

header_pattern = re.compile(r"^(?:\u200e)?\[(.+?)\]\s([^:]+):\s?(.*)$")
messages = []
current = None
for line in text.splitlines():
    match = header_pattern.match(line)
    is_top_level = bool(match and re.search(r"\b\d{1,2}:\d{2}:\d{2}\b", match.group(1)))
    if is_top_level:
        if current:
            messages.append(current)
        current = {
            "dt": match.group(1),
            "sender": match.group(2).strip(),
            "text": match.group(3),
        }
    elif current:
        current["text"] += "\n" + line
if current:
    messages.append(current)


def parse_dt(value: str):
    value = value.replace("\u202f", " ").replace("\xa0", " ")
    for fmt in ("%m/%d/%y, %I:%M:%S %p", "%m/%d/%Y, %I:%M:%S %p"):
        try:
            return datetime.datetime.strptime(value, fmt)
        except ValueError:
            pass
    return None


media_tail = re.compile(
    r"(?:\s|^)(?:audio|image|video|sticker|gif|document|contact card|location) omitted\s*$",
    re.IGNORECASE,
)


def clean_body(value: str):
    cleaned = value.replace("\u200e", "").replace("\u200f", "").strip()
    cleaned = media_tail.sub("", cleaned).strip()
    if not cleaned:
        return None

    low = cleaned.lower().strip()
    if low in (
        "this message was deleted",
        "messages and calls are end-to-end encrypted. only people in this chat can read, listen to, or share them.",
    ):
        return None
    if re.search(r"\bcreated this group$", low):
        return None
    if re.search(r"\badded you$", low):
        return None
    if re.search(r"\bjoined using this group", low):
        return None
    if re.search(r"\bchanged (their phone number|the group description|this group)", low):
        return None
    if re.search(r"\bpinned a message$", low):
        return None
    return cleaned


kept = []
for message in messages:
    dt = parse_dt(message["dt"])
    body = clean_body(message["text"])
    if not dt or not body:
        continue
    speaker = "Rav Rosenfeld" if message["sender"] == "Rav Rosenfeld" else "Participant"
    kept.append({"dt": dt, "speaker": speaker, "body": body})


def render_message(message):
    stamp = message["dt"].strftime("%Y-%m-%d %I:%M:%S %p").replace(" 0", " ")
    return f"[{stamp} — {message['speaker']}]\n{message['body']}"


def utf8_len(value: str) -> int:
    return len(value.encode("utf-8"))


def truncate_utf8(value: str, max_bytes: int) -> str:
    raw = value.encode("utf-8")
    if len(raw) <= max_bytes:
        return value
    clipped = raw[:max_bytes]
    while clipped:
        try:
            return clipped.decode("utf-8").rstrip() + "\n[truncated for Vectorize metadata limit]"
        except UnicodeDecodeError:
            clipped = clipped[:-1]
    return "[truncated]"


def build_source(center_index: int):
    before = kept[max(0, center_index - BEFORE_MESSAGES):center_index]
    center = kept[center_index]
    after = kept[center_index + 1:center_index + 1 + AFTER_MESSAGES]

    def render():
        return "\n\n".join(render_message(message) for message in [*before, center, *after])

    source = render()
    while utf8_len(source) > MAX_SOURCE_BYTES and before:
        before = before[1:]
        source = render()
    while utf8_len(source) > MAX_SOURCE_BYTES and after:
        after = after[:-1]
        source = render()
    if utf8_len(source) > MAX_SOURCE_BYTES:
        source = truncate_utf8(render_message(center), MAX_SOURCE_BYTES - 100)
    return source


out_path.parent.mkdir(parents=True, exist_ok=True)
rows = []
rav_number = 0
max_metadata_bytes = 0
for index, message in enumerate(kept):
    if message["speaker"] != "Rav Rosenfeld":
        continue
    rav_number += 1
    source_text = build_source(index)
    max_metadata_bytes = max(max_metadata_bytes, utf8_len(source_text))
    date = message["dt"].date().isoformat()
    vector_id = f"rav-{rav_number:05d}-{date}"
    embedding_text = (
        "Q and A with the Dayan archive. Retrieve this passage when the user's Halachic question "
        "is answered or materially addressed by the Rav Rosenfeld message below.\n\n"
        f"Primary Rav Rosenfeld answer:\n{message['body']}\n\n"
        f"Nearby chronological conversation:\n{source_text}"
    )
    rows.append(
        {
            "id": vector_id,
            "date": date,
            "embedding_text": embedding_text,
            "source_text": source_text,
        }
    )

with out_path.open("w", encoding="utf-8") as handle:
    for row in rows:
        handle.write(json.dumps(row, ensure_ascii=False) + "\n")

print(
    f"Created {len(rows)} Rav-centered Vectorize windows from {len(kept)} substantive messages. "
    f"Largest source_text metadata payload: {max_metadata_bytes} bytes. Output: {out_path}"
)
