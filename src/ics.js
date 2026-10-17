'use strict';

/** iCalendar (RFC 5545) export of saved schools' application deadlines and lottery dates (TRK-04). */

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets are folded with CRLF + space.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 character
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return parts.join('\r\n ');
}

const ymd = (iso) => iso.replace(/-/g, '');
function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildIcs(items, { now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NYC Charter School Finder//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Charter school deadlines'];
  for (const it of items) {
    const events = [];
    if (it.deadline) events.push(['deadline', it.deadline, `Application deadline: ${it.name}`]);
    if (it.lotteryDate) events.push(['lottery', it.lotteryDate, `Lottery: ${it.name}`]);
    for (const [kind, date, summary] of events) {
      lines.push(
        'BEGIN:VEVENT',
        `UID:${it.id}-${kind}-${date}@nyc-charter-finder`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${ymd(date)}`,
        `DTEND;VALUE=DATE:${ymd(nextDay(date))}`,
        `SUMMARY:${esc(summary)}`,
        `DESCRIPTION:${esc([it.note, it.applyUrl ? `Apply: ${it.applyUrl}` : ''].filter(Boolean).join('\n'))}`,
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

module.exports = { buildIcs, fold, esc };
