import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const outputPath = process.argv[2];
if (!outputPath) {
  throw new Error('Usage: node scripts/generate-last-commit-badge.mjs <output-path>');
}

const committedAt = execFileSync('git', ['log', '-1', '--format=%cI'], {
  encoding: 'utf8',
}).trim();
const committedAtDate = new Date(committedAt);
if (!committedAt || Number.isNaN(committedAtDate.getTime())) {
  throw new Error('Could not read the latest commit timestamp.');
}

const hoursOld = Math.floor(Math.max(0, Date.now() - committedAtDate.getTime()) / 3_600_000);
let message;
if (hoursOld < 24) {
  const displayedHours = Math.max(1, hoursOld);
  message = `${displayedHours} ${displayedHours === 1 ? 'hour' : 'hours'} ago`;
} else {
  const daysOld = Math.floor(hoursOld / 24);
  message = `${daysOld} ${daysOld === 1 ? 'day' : 'days'} ago`;
}
const color = hoursOld < 24 ? '#1a7f37' : hoursOld < 24 * 7 ? '#bf8700' : '#cf222e';
const label = 'last commit';
const labelWidth = 73;
const valueWidth = Math.max(58, message.length * 6.5 + 12);
const width = labelWidth + valueWidth;
const accessibleLabel = `Last commit ${message}`;
const timestamp = committedAtDate.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${accessibleLabel}">
  <title>${accessibleLabel} (committed ${timestamp})</title>
  <path fill="${color}" d="M3 0h${width - 6}a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3z"/>
  <path fill="#555" d="M3 0h${labelWidth - 3}v20H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3z"/>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${labelWidth / 2}" y="14">${label}</text>
    <text x="${labelWidth + valueWidth / 2}" y="14">${message}</text>
  </g>
</svg>
`;

await writeFile(outputPath, svg, 'utf8');
