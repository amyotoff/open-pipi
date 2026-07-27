import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PIPI_PUBLIC_BASE_URL } from '../config';
import type { Task } from '../db';

const BRIEF_DIR = path.join(DATA_DIR, 'briefs');
const BRIEF_RETENTION_DAYS = 30;
export const BRIEF_PIN_HOURS = 24;

export type BriefPage = {
    fileName: string;
    filePath: string;
    url: string | null;
};

function ensureBriefDir(): void {
    fs.mkdirSync(BRIEF_DIR, { recursive: true });
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function renderInline(value: string): string {
    const escaped = escapeHtml(value);
    return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function stripMarkdown(value: string): string {
    return value
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^-\s+/, '')
        .trim();
}

function looksLikeEventLine(value: string): boolean {
    return /\b(call|sync|meeting|event|standup|demo|review)\b|звон|созвон|синк|встреч|митинг|ивент|демо|ревью/i.test(
        value
    );
}

function extractEventLines(text: string): string[] {
    const seen = new Set<string>();
    const events: string[] = [];

    for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = stripMarkdown(rawLine);
        if (!line || !looksLikeEventLine(line)) continue;
        const key = line.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(line);
    }

    return events;
}

function renderBriefBody(text: string): string {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let inList = false;
    let sectionIndex = 0;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            if (inList) {
                html.push('</ul>');
                inList = false;
            }
            continue;
        }

        if (line.startsWith('- ')) {
            if (!inList) {
                html.push('<ul>');
                inList = true;
            }
            html.push(`<li>${renderInline(line.substring(2))}</li>`);
            continue;
        }

        if (inList) {
            html.push('</ul>');
            inList = false;
        }

        const heading = line.match(/^\*\*([^*]+)\*\*$/);
        if (heading) {
            const sectionEmoji = ['🌤', '📌', '🔎', '✨'][sectionIndex % 4];
            sectionIndex += 1;
            html.push(`<h2>${sectionEmoji} ${renderInline(heading[1])}</h2>`);
            continue;
        }

        html.push(`<p>${renderInline(line)}</p>`);
    }

    if (inList) {
        html.push('</ul>');
    }

    const events = extractEventLines(text);
    if (events.length > 0) {
        html.push('<aside class="events">');
        html.push('<h2>🗓 Синки и события</h2>');
        html.push('<ul>');
        for (const event of events) {
            html.push(`<li>${renderInline(event)}</li>`);
        }
        html.push('</ul>');
        html.push('</aside>');
    }

    return html.join('\n');
}

function buildBriefHtml(args: { title: string; spaceId: string; text: string; createdAt: Date }): string {
    const title = args.title || 'Daily Brief';
    const createdLabel = args.createdAt.toLocaleString('en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: process.env.TZ || undefined,
    });

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(135deg, rgba(255, 218, 121, 0.28), transparent 34%),
        linear-gradient(315deg, rgba(81, 176, 255, 0.20), transparent 38%),
        #fbfaf7;
      color: #171717;
      line-height: 1.55;
    }
    main {
      max-width: 760px;
      margin: 0 auto;
      padding: 32px 18px 56px;
    }
    header {
      border-bottom: 1px solid #ded7c9;
      margin-bottom: 24px;
      padding-bottom: 16px;
    }
    .kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      padding: 5px 10px;
      border: 1px solid #e1d4bc;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.58);
      color: #665b48;
      font-size: 13px;
      font-weight: 650;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(28px, 6vw, 44px);
      line-height: 1.08;
      letter-spacing: 0;
    }
    .meta {
      color: #68635b;
      font-size: 14px;
    }
    h2 {
      margin: 26px 0 10px;
      font-size: 22px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    p {
      margin: 0 0 14px;
      font-size: 18px;
    }
    ul {
      margin: 0 0 16px;
      padding-left: 22px;
    }
    li {
      margin: 0 0 8px;
      font-size: 18px;
    }
    li::marker {
      content: "•  ";
      color: #d0782f;
      font-size: 20px;
    }
    .events {
      margin-top: 34px;
      padding: 18px 18px 14px;
      border: 1px solid #dfd3bf;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.62);
    }
    .events h2 {
      margin-top: 0;
    }
    .events ul {
      margin-bottom: 0;
    }
    strong { font-weight: 700; }
    @media (prefers-color-scheme: dark) {
      body {
        background:
          linear-gradient(135deg, rgba(255, 196, 87, 0.16), transparent 34%),
          linear-gradient(315deg, rgba(83, 167, 255, 0.15), transparent 38%),
          #151515;
        color: #f2f0ea;
      }
      header { border-bottom-color: #3a3834; }
      .kicker {
        background: rgba(255, 255, 255, 0.08);
        border-color: #4b463d;
        color: #d9d0c2;
      }
      .events {
        background: rgba(255, 255, 255, 0.07);
        border-color: #4b463d;
      }
      .meta { color: #aaa39a; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="kicker">☕ Daily Brief</div>
      <h1>🌞 ${escapeHtml(title)}</h1>
      <div class="meta">${escapeHtml(createdLabel)} · ${escapeHtml(args.spaceId)}</div>
    </header>
    <section>
${renderBriefBody(args.text)}
    </section>
  </main>
</body>
</html>
`;
}

function slugify(value: string): string {
    return (
        value
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .substring(0, 48) || 'brief'
    );
}

function buildBriefUrl(fileName: string): string | null {
    const publicBaseUrl = (process.env.PIPI_PUBLIC_BASE_URL || PIPI_PUBLIC_BASE_URL).replace(/\/+$/, '');
    if (publicBaseUrl) {
        return `${publicBaseUrl}/briefs/${fileName}`;
    }

    return null;
}

export function getBriefPagesDir(): string {
    return BRIEF_DIR;
}

export function getBriefPagePath(fileName: string): string | null {
    if (!/^[a-z0-9][a-z0-9.-]*\.html$/.test(fileName)) {
        return null;
    }
    return path.join(BRIEF_DIR, fileName);
}

export function cleanupOldBriefPages(now: Date = new Date(), retentionDays = BRIEF_RETENTION_DAYS): number {
    ensureBriefDir();
    const cutoffMs = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const entry of fs.readdirSync(BRIEF_DIR, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
        const filePath = path.join(BRIEF_DIR, entry.name);
        const stats = fs.statSync(filePath);
        if (stats.mtimeMs >= cutoffMs) continue;
        fs.unlinkSync(filePath);
        removed += 1;
    }

    return removed;
}

export function createBriefPage(args: {
    spaceId: string;
    taskTitle: string;
    text: string;
    createdAt?: Date;
}): BriefPage {
    ensureBriefDir();
    cleanupOldBriefPages(args.createdAt || new Date());

    const createdAt = args.createdAt || new Date();
    const day = createdAt.toISOString().slice(0, 10);
    // The URL is the only thing protecting this page: it is linked from a
    // chat and therefore cannot require a session. The rest of the name is
    // the date and the space, both guessable, so the random part carries
    // all of the secrecy and needs to be long enough to be worth calling one.
    const random = crypto.randomBytes(16).toString('hex');
    const fileName = `${day}-${slugify(args.spaceId)}-${random}.html`;
    const filePath = path.join(BRIEF_DIR, fileName);

    fs.writeFileSync(
        filePath,
        buildBriefHtml({
            title: args.taskTitle || 'Daily Brief',
            spaceId: args.spaceId,
            text: args.text,
            createdAt,
        }),
        'utf8'
    );

    return {
        fileName,
        filePath,
        url: buildBriefUrl(fileName),
    };
}

function parseTaskConfig(raw: string | null | undefined): { seeded?: { template_id?: string } } {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw) as { seeded?: { template_id?: string } };
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

export function shouldCreateDailyBriefPage(task: Task | undefined): task is Task {
    if (!task || task.kind !== 'assistant_prompt') return false;
    const templateId = parseTaskConfig(task.config_json).seeded?.template_id;
    return templateId === 'briefing_morning';
}
