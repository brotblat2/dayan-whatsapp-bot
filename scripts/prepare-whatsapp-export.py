#!/usr/bin/env python3
"""Convert a WhatsApp exported chat ZIP/TXT into anonymized monthly Markdown files.

Usage:
  python3 scripts/prepare-whatsapp-export.py "/path/to/WhatsApp Chat.zip" [output-dir]
"""
from pathlib import Path
import zipfile, re, collections, datetime, sys, shutil

if len(sys.argv) < 2:
    raise SystemExit('Usage: python3 scripts/prepare-whatsapp-export.py "/path/to/WhatsApp Chat.zip" [output-dir]')

src = Path(sys.argv[1]).expanduser().resolve()
out_dir = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else Path('sources').resolve()

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
    for fmt in ('%m/%d/%y, %I:%M:%S %p', '%m/%d/%Y, %I:%M:%S %p'):
        try:
            return datetime.datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None

def substantive(t):
    x = t.strip()
    if not x or x.startswith(('\u200e', '\u200f', '‎')):
        return False
    low = x.lower()
    return not any(marker in low for marker in (
        'this message was deleted', 'audio omitted', 'image omitted', 'video omitted',
        'sticker omitted', 'gif omitted', 'document omitted', 'contact card omitted',
        'location omitted'
    ))

months = collections.defaultdict(list)
kept = rav_count = 0
for msg in messages:
    if not substantive(msg['text']):
        continue
    dt = parse_dt(msg['dt'])
    if not dt:
        continue
    speaker = 'Rav Rosenfeld' if msg['sender'] == 'Rav Rosenfeld' else 'Participant'
    rav_count += speaker == 'Rav Rosenfeld'
    kept += 1
    body = msg['text'].replace('\u200e', '').replace('\u200f', '').strip()
    months[(dt.year, dt.month)].append((dt, speaker, body))

if out_dir.exists():
    shutil.rmtree(out_dir)
out_dir.mkdir(parents=True)

for (year, month), items in sorted(months.items()):
    path = out_dir / f'Q-and-A-with-the-Dayan-{year}-{month:02d}.md'
    title = datetime.date(year, month, 1).strftime('%B %Y')
    lines = [
        f'# Q and A with the Dayan — {title}', '',
        '> Cleaned chronological archive. Participant sender labels are anonymized. Rav Rosenfeld messages are preserved as Rav Rosenfeld; participant messages provide question/context.', ''
    ]
    last_date = None
    for dt, speaker, body in items:
        date = dt.strftime('%Y-%m-%d')
        if date != last_date:
            lines += [f'## {date}', '']
            last_date = date
        lines += [f'**{speaker} — {dt.strftime("%I:%M:%S %p").lstrip("0")}:**', body, '']
    path.write_text('\n'.join(lines), encoding='utf-8')

print(f'Created {len(months)} monthly files with {kept} substantive messages, including {rav_count} Rav Rosenfeld messages, in {out_dir}')
