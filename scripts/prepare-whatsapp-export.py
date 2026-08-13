#!/usr/bin/env python3
"""Convert a WhatsApp exported chat ZIP/TXT into retrieval-optimized weekly Markdown windows.

Each output file contains one ISO week of substantive messages plus a small amount of
chronological context from the neighboring weeks. Participant names are anonymized;
Rav Rosenfeld is preserved as the archive authority.

Usage:
  python3 scripts/prepare-whatsapp-export.py "/path/to/WhatsApp Chat.zip" [output-dir]
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
    if m:
        if cur:
            messages.append(cur)
        cur = {'dt': m.group(1), 'sender': m.group(2).strip(), 'text': m.group(3)}
    elif cur:
        cur['text'] += '\n' + line
if cur:
    messages.append(cur)

def parse_dt(s):
    s = s.replace('\u202f', ' ').replace('\xa0', ' ')
    for fmt in (
        '%m/%d/%y, %I:%M:%S %p',
        '%m/%d/%Y, %I:%M:%S %p',
        '%m/%d/%y, %I:%M %p',
        '%m/%d/%Y, %I:%M %p',
    ):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None

def substantive(t):
    # Directional marks are common in normal WhatsApp exports, so strip them instead
    # of treating their presence as evidence that a message is a system notice.
    x = t.replace('\u200e', '').replace('\u200f', '').strip()
    if not x:
        return False
    low = x.lower()
    return not any(marker in low for marker in (
        'this message was deleted', 'audio omitted', 'image omitted', 'video omitted',
        'sticker omitted', 'gif omitted', 'document omitted', 'contact card omitted',
        'location omitted', 'security code with', 'changed their phone number',
        'changed the group description', 'changed this group', 'created group',
        'added ~', 'removed ~', 'pinned a message', 'joined using this group'
    ))

kept_messages = []
rav_count = 0
for msg in messages:
    if not substantive(msg['text']):
        continue
    dt = parse_dt(msg['dt'])
    if not dt:
        continue
    speaker = 'Rav Rosenfeld' if msg['sender'] == 'Rav Rosenfeld' else 'Participant'
    rav_count += speaker == 'Rav Rosenfeld'
    body = msg['text'].replace('\u200e', '').replace('\u200f', '').strip()
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
    path = out_dir / f'retrieval-v2-{iso_year}-W{iso_week:02d}.md'
    lines = [
        f'# Q and A with the Dayan — retrieval window {iso_year}-W{iso_week:02d}',
        '',
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
            ''
        ]

    path.write_text('\n'.join(lines), encoding='utf-8')

print(
    f'Created {len(weeks)} retrieval-v2 weekly files from {len(kept_messages)} substantive messages, '
    f'including {rav_count} Rav Rosenfeld messages, in {out_dir}'
)
