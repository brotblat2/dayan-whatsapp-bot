#!/usr/bin/env python3
"""Convert a WhatsApp export into retrieval-optimized weekly Markdown windows.

Important parsing choices for this archive:
- Top-level exported messages contain timestamps with seconds. Quoted/pasted older
  WhatsApp messages often look like message headers but omit seconds, so they stay
  inside the parent message instead of becoming fake historical top-level messages.
- WhatsApp can append "image omitted" (and similar media markers) to an otherwise
  substantive text question. We remove the trailing media marker instead of dropping
  the whole question.
- Participant names are anonymized; only top-level sender "Rav Rosenfeld" is authority.
"""
from pathlib import Path
import zipfile, re, collections, datetime, sys, shutil

if len(sys.argv) < 2:
    raise SystemExit('Usage: python3 scripts/prepare-whatsapp-export.py "/path/to/WhatsApp Chat.zip" [output-dir]')

src = Path(sys.argv[1]).expanduser().resolve()
out_dir = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else Path('sources').resolve()
CONTEXT_MESSAGES = 8

if src.suffix.lower() == '.zip':
    with zipfile.ZipFile(src) as z:
        candidates = [n for n in z.namelist() if n.lower().endswith('.txt')]
        if not candidates:
            raise SystemExit('No .txt chat export found inside the ZIP')
        text = z.read(candidates[0]).decode('utf-8-sig', errors='replace')
else:
    text = src.read_text(encoding='utf-8-sig', errors='replace')

pat = re.compile(r'^(?:\u200e)?\[(.+?)\]\s([^:]+):\s?(.*)$')
messages = []
cur = None
for line in text.splitlines():
    m = pat.match(line)
    # This export's real message headers include seconds. Pasted/quoted historical
    # messages frequently omit them; treating those as top-level corrupts chronology.
    is_top_level = bool(m and re.search(r'\b\d{1,2}:\d{2}:\d{2}\b', m.group(1)))
    if is_top_level:
        if cur:
            messages.append(cur)
        cur = {'dt': m.group(1), 'sender': m.group(2).strip(), 'text': m.group(3)}
    elif cur:
        cur['text'] += '\n' + line
if cur:
    messages.append(cur)

def parse_dt(s):
    s = s.replace('\u202f', ' ').replace('\xa0', ' ')
    for fmt in ('%m/%d/%y, %I:%M:%S %p', '%m/%d/%Y, %I:%M:%S %p'):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None

media_tail = re.compile(
    r'(?:\s|^)(?:audio|image|video|sticker|gif|document|contact card|location) omitted\s*$',
    re.IGNORECASE,
)

def clean_body(t):
    # Directional marks are common on real WhatsApp messages and are not a reason
    # to drop a message.
    x = t.replace('\u200e', '').replace('\u200f', '').strip()
    # Preserve text that accompanied media. Example: a complete Halachic question
    # followed by "image omitted" should remain searchable.
    x = media_tail.sub('', x).strip()
    if not x:
        return None

    low = x.lower().strip()
    if low in (
        'this message was deleted',
        'messages and calls are end-to-end encrypted. only people in this chat can read, listen to, or share them.',
    ):
        return None
    if re.search(r'\bcreated this group$', low):
        return None
    if re.search(r'\badded you$', low):
        return None
    if re.search(r'\bjoined using this group', low):
        return None
    if re.search(r'\bchanged (their phone number|the group description|this group)', low):
        return None
    if re.search(r'\bpinned a message$', low):
        return None
    return x

kept_messages = []
rav_count = 0
for msg in messages:
    dt = parse_dt(msg['dt'])
    body = clean_body(msg['text'])
    if not dt or not body:
        continue
    speaker = 'Rav Rosenfeld' if msg['sender'] == 'Rav Rosenfeld' else 'Participant'
    rav_count += speaker == 'Rav Rosenfeld'
    kept_messages.append({'dt': dt, 'speaker': speaker, 'body': body})

weeks = collections.defaultdict(list)
for idx, msg in enumerate(kept_messages):
    iso = msg['dt'].isocalendar()
    weeks[(iso.year, iso.week)].append(idx)

if out_dir.exists():
    shutil.rmtree(out_dir)
out_dir.mkdir(parents=True)

for (iso_year, iso_week), indices in sorted(weeks.items()):
    first = max(0, indices[0] - CONTEXT_MESSAGES)
    last = min(len(kept_messages), indices[-1] + CONTEXT_MESSAGES + 1)

    monday = datetime.date.fromisocalendar(iso_year, iso_week, 1)
    sunday = monday + datetime.timedelta(days=6)
    path = out_dir / f'retrieval-v3-{iso_year}-W{iso_week:02d}.md'
    lines = [
        f'# Q and A with the Dayan — retrieval window {iso_year}-W{iso_week:02d}', '',
        f'> Central week: {monday.isoformat()} through {sunday.isoformat()}.',
        '> Retrieval-optimized chronological window. A few messages from before and after the week are intentionally repeated so questions and Rav Rosenfeld answers are less likely to be separated by a file boundary.',
        '> Participant sender names are anonymized. Only messages labeled Rav Rosenfeld are authoritative archive answers.',
        '',
    ]

    central = set(indices)
    last_date = None
    for absolute_idx in range(first, last):
        msg = kept_messages[absolute_idx]
        date = msg['dt'].date().isoformat()
        if date != last_date:
            lines += [f'## {date}', '']
            last_date = date
        context_mark = '' if absolute_idx in central else ' [boundary context]'
        stamp = msg['dt'].strftime('%Y-%m-%d %I:%M:%S %p').replace(' 0', ' ')
        lines += [
            f'### {stamp} — {msg["speaker"]}{context_mark}',
            msg['body'],
            '',
        ]

    path.write_text('\n'.join(lines), encoding='utf-8')

print(
    f'Created {len(weeks)} retrieval-v3 weekly files from {len(kept_messages)} substantive messages, '
    f'including {rav_count} Rav Rosenfeld messages, in {out_dir}'
)
