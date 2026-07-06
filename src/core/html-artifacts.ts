import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PIPI_PUBLIC_BASE_URL } from '../config';
import { listTasks } from '../db';

const HTML_ARTIFACT_DIR = path.join(DATA_DIR, 'html-artifacts');

export const HTML_ARTIFACT_KINDS = [
    'plan',
    'research',
    'brief',
    'report',
    'decision_memo',
    'work_plan',
    'meeting_notes',
    'kanban_board',
    'agent_plan',
    'task_board',
] as const;

export type HtmlArtifactKind = (typeof HTML_ARTIFACT_KINDS)[number];

export type HtmlArtifactPage = {
    fileName: string;
    filePath: string;
    url: string | null;
};

export type HtmlArtifactListEntry = {
    fileName: string;
    filePath: string;
    url: string | null;
    size: number;
    updatedAt: string;
};

function ensureHtmlArtifactDir(): void {
    fs.mkdirSync(HTML_ARTIFACT_DIR, { recursive: true });
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
    return escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`]+)`/g, '<code>$1</code>');
}

function stripMarkdown(value: string): string {
    return value
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/^[-*]\s+/, '')
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

type KanbanColumnKey = 'todo' | 'doing' | 'done';

const KANBAN_COLUMNS: Array<{ key: KanbanColumnKey; title: string }> = [
    { key: 'todo', title: 'To do' },
    { key: 'doing', title: 'In progress' },
    { key: 'done', title: 'Done' },
];

function normalizeKanbanColumn(value: string): KanbanColumnKey | null {
    const normalized = stripMarkdown(value).toLowerCase().replace(/[_-]+/g, ' ').trim();

    if (/^(todo|to do|backlog|planned|к сделать|надо|план|ожидает)/i.test(normalized)) return 'todo';
    if (/^(doing|in progress|progress|active|в работе|делаем|сейчас)/i.test(normalized)) return 'doing';
    if (/^(done|complete|completed|closed|готово|сделано|закрыто)/i.test(normalized)) return 'done';

    return null;
}

function renderKanbanBoard(text: string): string {
    const cards: Record<KanbanColumnKey, string[]> = {
        todo: [],
        doing: [],
        done: [],
    };
    let currentColumn: KanbanColumnKey = 'todo';

    for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;

        const heading = line.match(/^(?:#{1,3}\s+|\*\*)(.+?)(?:\*\*)?$/);
        const headingColumn = normalizeKanbanColumn(heading ? heading[1] : line);
        if (headingColumn && !line.startsWith('- ') && !line.startsWith('* ')) {
            currentColumn = headingColumn;
            continue;
        }

        if (!line.startsWith('- ') && !line.startsWith('* ')) continue;

        let cardText = stripMarkdown(line);
        const inlineStatus = cardText.match(/^\[([^\]]+)\]\s*(.+)$/);
        const inlineColumn = inlineStatus ? normalizeKanbanColumn(inlineStatus[1]) : null;
        if (inlineStatus && inlineColumn) {
            currentColumn = inlineColumn;
            cardText = inlineStatus[2].trim();
        }

        if (cardText) {
            cards[inlineColumn || currentColumn].push(cardText);
        }
    }

    const columns = KANBAN_COLUMNS.map((column) => {
        const renderedCards = cards[column.key].map((card) => {
            const cardId = crypto.createHash('sha1').update(`${column.key}:${card}`).digest('hex').slice(0, 12);

            return `<article class="kanban-card" draggable="true" data-card-id="${cardId}">${renderInline(card)}</article>`;
        });

        return `<section class="kanban-column" data-status="${column.key}">
  <h2>${escapeHtml(column.title)} <span class="kanban-count">${renderedCards.length}</span></h2>
  <div class="kanban-cards">${renderedCards.join('\n') || '<p class="kanban-empty">No tasks yet.</p>'}</div>
</section>`;
    });

    return `<div class="kanban-board" data-kanban-board>
${columns.join('\n')}
</div>
<p class="kanban-footnote">Status moves on this page are saved in this browser. Regenerate the shared board when the team-visible status changes.</p>`;
}

type RenderTask = {
    title: string;
    time: string;
    completed: boolean;
    integrations: string[];
};

function parseCronTime(cronValue: string): string {
    const parts = cronValue.trim().split(/\s+/);
    if (parts.length >= 2) {
        const min = parts[0].padStart(2, '0');
        const hr = parts[1].padStart(2, '0');
        if (/^\d+$/.test(min) && /^\d+$/.test(hr)) {
            return `${hr}:${min}`;
        }
    }
    return '09:00';
}

function parseTasksFromBody(text: string): RenderTask[] {
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const tasks: RenderTask[] = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();
        const match = line.match(/^[-*]\s+\[([ x])\]\s+(.+)$/i);
        if (!match) continue;

        const completed = match[1].toLowerCase() === 'x';
        let remaining = match[2].trim();

        let time = '09:00';
        const timeMatch = remaining.match(/\(?(\d{2}:\d{2})\)?/);
        if (timeMatch) {
            time = timeMatch[1];
            remaining = remaining.replace(timeMatch[0], '').trim();
        }

        const integrations: string[] = [];
        const integrationMatch = remaining.match(/\[([^\]]+)\]/);
        if (integrationMatch) {
            const list = integrationMatch[1].split(',').map((s) => s.trim().toLowerCase());
            for (const item of list) {
                if (['calendar', 'gmail', 'docs', 'gcal', 'gdocs', 'notion', 'mail'].includes(item)) {
                    integrations.push(item);
                }
            }
            remaining = remaining.replace(integrationMatch[0], '').trim();
        }

        const title = remaining.replace(/\s+/g, ' ').trim();
        if (title) {
            tasks.push({ title, time, completed, integrations });
        }
    }

    return tasks;
}

function getTasksFromDb(spaceId: string): RenderTask[] {
    const dbTasks = listTasks(spaceId, 'active');
    const tasks: RenderTask[] = [];

    for (const task of dbTasks) {
        const time = parseCronTime(task.schedule_value);

        let completed = false;
        if (task.last_run_at) {
            const runDate = new Date(task.last_run_at);
            const now = new Date();
            completed =
                runDate.getDate() === now.getDate() &&
                runDate.getMonth() === now.getMonth() &&
                runDate.getFullYear() === now.getFullYear();
        }

        const integrations: string[] = [];
        const key = (task.id + ' ' + task.title).toLowerCase();
        if (key.includes('morning') || key.includes('brief') || key.includes('утро')) {
            integrations.push('calendar', 'gmail');
        } else if (
            key.includes('evening') ||
            key.includes('wrapup') ||
            key.includes('reset') ||
            key.includes('вечер') ||
            key.includes('недел')
        ) {
            integrations.push('calendar', 'docs');
        } else if (key.includes('atelier') || key.includes('ticket') || key.includes('dev')) {
            integrations.push('docs', 'notion');
        } else {
            integrations.push('calendar');
        }

        tasks.push({
            title: task.title,
            time,
            completed,
            integrations,
        });
    }

    tasks.sort((a, b) => a.time.localeCompare(b.time));
    return tasks;
}

function renderIntegrationIcon(name: string): string {
    const iconName = name.toLowerCase().trim();
    if (iconName === 'calendar' || iconName === 'gcal') {
        return `<div class="agent-plan-icon" title="Google Calendar">
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="6" width="36" height="36" rx="8" fill="#1a73e8"/>
            <path d="M6 16H42" stroke="white" stroke-width="4"/>
            <text x="50%" y="74%" font-size="18" font-weight="900" fill="white" text-anchor="middle" dominant-baseline="middle" font-family="'Outfit', sans-serif">31</text>
          </svg>
        </div>`;
    }
    if (iconName === 'gmail' || iconName === 'mail') {
        return `<div class="agent-plan-icon" title="Gmail">
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="6" y="8" width="36" height="32" rx="6" fill="white" stroke="#ea4335" stroke-width="3"/>
            <path d="M6 10L24 24L42 10" stroke="#ea4335" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M6 38V22L18 30L6 38Z" fill="#ea4335"/>
            <path d="M42 38V22L30 30L42 38Z" fill="#ea4335"/>
          </svg>
        </div>`;
    }
    if (iconName === 'docs' || iconName === 'gdocs') {
        return `<div class="agent-plan-icon" title="Google Docs">
          <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 6C10 4.89543 10.8954 4 12 4H30L38 12V42C38 43.1046 37.1046 44 36 44H12C10.8954 44 10 43.1046 10 42V6Z" fill="#2f80ed"/>
            <path d="M30 4V12H38L30 4Z" fill="#90caf9"/>
            <path d="M16 20H32" stroke="white" stroke-width="3" stroke-linecap="round"/>
            <path d="M16 28H32" stroke="white" stroke-width="3" stroke-linecap="round"/>
            <path d="M16 36H26" stroke="white" stroke-width="3" stroke-linecap="round"/>
          </svg>
        </div>`;
    }
    return `<div class="agent-plan-icon" title="${escapeHtml(name)}">
      <svg width="20" height="20" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="24" cy="24" r="20" fill="url(#wave-grad)"/>
        <path d="M16 24C20 18 28 30 32 20" stroke="white" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
        <defs>
          <linearGradient id="wave-grad" x1="0" y1="0" x2="48" y2="48" gradientUnits="userSpaceOnUse">
            <stop stop-color="#8b5cf6"/>
            <stop offset="1" stop-color="#3b82f6"/>
          </linearGradient>
        </defs>
      </svg>
    </div>`;
}

function renderAgentPlan(text: string, spaceId: string): string {
    const hasList =
        text.includes('- [ ]') || text.includes('- [x]') || text.includes('* [ ]') || text.includes('* [x]');
    const tasks = hasList ? parseTasksFromBody(text) : getTasksFromDb(spaceId);

    if (tasks.length === 0) {
        return `
        <div class="agent-plan-card" style="padding: 30px; text-align: center;">
          <p style="color: rgba(255, 255, 255, 0.6); margin: 0; font-size: 16px;">Нет запланированных задач на сегодня.</p>
        </div>`;
    }

    const renderedTasks = tasks.map((task) => {
        const statusClass = task.completed ? 'completed' : 'pending';
        const itemClass = task.completed ? 'agent-plan-item is-completed' : 'agent-plan-item';
        const statusIcon = task.completed
            ? `<svg width="14" height="10" viewBox="0 0 14 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 5L5 9L13 1" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>`
            : `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
                <circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="2"/>
                <path d="M7 3.5V7H10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              </svg>`;

        const integrationsMarkup = task.integrations.map(renderIntegrationIcon).join('\n');

        return `
        <div class="${itemClass}">
          <div class="agent-plan-status ${statusClass}">${statusIcon}</div>
          <div class="agent-plan-details">
            <span class="agent-plan-title">${renderInline(task.title)}</span>
            <span class="agent-plan-time">${task.time}</span>
          </div>
          <div class="agent-plan-integrations">${integrationsMarkup}</div>
        </div>`;
    });

    return `
    <div class="agent-plan-card">
      ${renderedTasks.join('\n')}
      <div class="agent-plan-footer">
        <span class="agent-plan-more">•••</span>
        <a href="#" class="agent-plan-link">Все задачи</a>
      </div>
    </div>`;
}

function renderTaskBoard(spaceId: string): string {
    const allTasks = listTasks(spaceId);
    const groups: Record<'active' | 'paused' | 'completed', typeof allTasks> = {
        active: [],
        paused: [],
        completed: [],
    };
    for (const task of allTasks) {
        if (task.status === 'paused') groups.paused.push(task);
        else if (task.status === 'completed' || task.status === 'cancelled') groups.completed.push(task);
        else groups.active.push(task);
    }

    const TASK_BOARD_COLUMNS: Array<{ key: 'active' | 'paused' | 'completed'; title: string }> = [
        { key: 'active', title: 'Active' },
        { key: 'paused', title: 'Paused' },
        { key: 'completed', title: 'Completed' },
    ];

    const columns = TASK_BOARD_COLUMNS.map((col) => {
        const tasks = groups[col.key];
        const cards = tasks.map((task) => {
            const schedule = task.schedule_value || '';
            const lastRun = task.last_run_at
                ? `Last run: ${task.last_run_at.substring(0, 16).replace('T', ' ')}`
                : 'Never run';
            return `<article class="kanban-card">
  <strong>${escapeHtml(task.title)}</strong>
  <div class="task-board-meta">Schedule: ${escapeHtml(schedule)}</div>
  <div class="task-board-meta">${escapeHtml(lastRun)}</div>
  <div class="task-board-meta">Status: ${escapeHtml(task.status)}</div>
</article>`;
        });

        return `<section class="kanban-column" data-status="${col.key}">
  <h2>${escapeHtml(col.title)} <span class="kanban-count">${cards.length}</span></h2>
  <div class="kanban-cards">${cards.join('\n') || '<p class="kanban-empty">No tasks.</p>'}</div>
</section>`;
    });

    return `<div class="kanban-board">
${columns.join('\n')}
</div>`;
}

function renderBody(text: string, kind: HtmlArtifactKind, spaceId: string): string {
    if (kind === 'kanban_board') {
        return renderKanbanBoard(text);
    }
    if (kind === 'agent_plan') {
        return renderAgentPlan(text, spaceId);
    }
    if (kind === 'task_board') {
        return renderTaskBoard(spaceId);
    }

    const lines = text.replace(/\r\n/g, '\n').split('\n');
    const html: string[] = [];
    let inList = false;
    let sectionIndex = 0;

    const closeList = () => {
        if (!inList) return;
        html.push('</ul>');
        inList = false;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            closeList();
            continue;
        }

        const heading = line.match(/^(?:#{1,3}\s+|\*\*)(.+?)(?:\*\*)?$/);
        if (heading && !line.startsWith('- ')) {
            closeList();
            const sectionEmoji = ['🧭', '📌', '🔎', '✅', '⚠️'][sectionIndex % 5];
            sectionIndex += 1;
            html.push(`<h2>${sectionEmoji} ${renderInline(stripMarkdown(heading[1]))}</h2>`);
            continue;
        }

        if (line.startsWith('- ') || line.startsWith('* ')) {
            if (!inList) {
                html.push('<ul>');
                inList = true;
            }
            html.push(`<li>${renderInline(line.substring(2))}</li>`);
            continue;
        }

        closeList();
        html.push(`<p>${renderInline(line)}</p>`);
    }

    closeList();

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

function labelForKind(kind: HtmlArtifactKind): string {
    const labels: Record<HtmlArtifactKind, string> = {
        plan: 'Plan',
        research: 'Research',
        brief: 'Brief',
        report: 'Report',
        decision_memo: 'Decision Memo',
        work_plan: 'Work Plan',
        meeting_notes: 'Meeting Notes',
        kanban_board: 'Kanban Board',
        agent_plan: 'Agent Plan',
        task_board: 'Task Board',
    };
    return labels[kind];
}

function emojiForKind(kind: HtmlArtifactKind): string {
    const labels: Record<HtmlArtifactKind, string> = {
        plan: '🧭',
        research: '🔬',
        brief: '✨',
        report: '📊',
        decision_memo: '⚖️',
        work_plan: '🛠',
        meeting_notes: '📝',
        kanban_board: '📋',
        agent_plan: '🤖',
        task_board: '📋',
    };
    return labels[kind];
}

function renderHtml(args: {
    kind: HtmlArtifactKind;
    title: string;
    summary?: string;
    body: string;
    spaceId: string;
    createdAt: Date;
}): string {
    const label = labelForKind(args.kind);
    const emoji = emojiForKind(args.kind);
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
  ${args.kind === 'task_board' ? '<meta http-equiv="refresh" content="60">' : ''}
  <title>${escapeHtml(args.title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background:
        linear-gradient(135deg, rgba(106, 180, 255, 0.20), transparent 34%),
        linear-gradient(315deg, rgba(255, 203, 98, 0.24), transparent 38%),
        #fbfaf7;
      color: #171717;
      line-height: 1.55;
    }
    /* Agent Plan Styles */
    body.agent-plan-theme {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: radial-gradient(circle at 0% 0%, rgba(59, 130, 246, 0.22) 0%, transparent 45%),
                  radial-gradient(circle at 100% 0%, rgba(139, 92, 246, 0.22) 0%, transparent 45%),
                  radial-gradient(circle at 100% 100%, rgba(236, 72, 153, 0.22) 0%, transparent 45%),
                  radial-gradient(circle at 0% 100%, rgba(20, 184, 166, 0.22) 0%, transparent 45%),
                  #070a13;
      color: #ffffff;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    body.agent-plan-theme main {
      max-width: 620px;
      width: 100%;
      padding: 40px 20px;
      box-sizing: border-box;
    }
    body.agent-plan-theme header {
      border-bottom: none;
      margin-bottom: 24px;
      padding-bottom: 0;
      text-align: center;
    }
    body.agent-plan-theme h1 {
      color: #ffffff;
      font-size: 34px;
      font-weight: 700;
      margin: 0;
      letter-spacing: -0.5px;
      text-shadow: 0 2px 10px rgba(0, 0, 0, 0.3);
    }
    body.agent-plan-theme .kicker,
    body.agent-plan-theme .meta,
    body.agent-plan-theme .summary {
      display: none;
    }
    .agent-plan-card {
      background: rgba(255, 255, 255, 0.07);
      backdrop-filter: blur(25px);
      -webkit-backdrop-filter: blur(25px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 30px;
      padding: 12px 28px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
    }
    .agent-plan-item {
      display: flex;
      align-items: center;
      padding: 18px 0;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .agent-plan-item:last-of-type {
      border-bottom: none;
    }
    .agent-plan-item:hover {
      transform: translateX(6px);
    }
    .agent-plan-status {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      margin-right: 16px;
      flex-shrink: 0;
    }
    .agent-plan-status.completed {
      background: rgba(255, 255, 255, 0.2);
      color: #ffffff;
    }
    .agent-plan-status.pending {
      background: rgba(255, 255, 255, 0.08);
      border: 2px solid rgba(255, 255, 255, 0.25);
      color: rgba(255, 255, 255, 0.7);
    }
    .agent-plan-details {
      flex-grow: 1;
      display: flex;
      flex-direction: column;
    }
    .agent-plan-title {
      font-size: 16px;
      font-weight: 500;
      color: #ffffff;
      line-height: 1.45;
      transition: all 0.3s ease;
    }
    .agent-plan-item.is-completed .agent-plan-title {
      color: rgba(255, 255, 255, 0.4);
      text-decoration: line-through;
    }
    .agent-plan-time {
      font-size: 13px;
      color: rgba(255, 255, 255, 0.5);
      margin-top: 4px;
      font-weight: 400;
    }
    .agent-plan-integrations {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-left: 16px;
    }
    .agent-plan-icon {
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: 0 4px 10px rgba(0, 0, 0, 0.15);
      transition: all 0.2s ease;
    }
    .agent-plan-icon:hover {
      background: rgba(255, 255, 255, 0.15);
      transform: scale(1.08);
    }
    .agent-plan-footer {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 0 12px;
      font-weight: 500;
    }
    .agent-plan-more {
      color: rgba(255, 255, 255, 0.3);
      letter-spacing: 1px;
      font-size: 14px;
    }
    .agent-plan-link {
      color: #38bdf8;
      text-decoration: none;
      font-size: 15px;
      transition: all 0.3s ease;
    }
    .agent-plan-link:hover {
      color: #ffffff;
      text-shadow: 0 0 8px rgba(56, 189, 248, 0.8);
    }
    main {
      max-width: 820px;
      margin: 0 auto;
      padding: 34px 18px 60px;
    }
    header {
      border-bottom: 1px solid #ded7c9;
      margin-bottom: 24px;
      padding-bottom: 18px;
    }
    .kicker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      padding: 5px 10px;
      border: 1px solid #d9d0bf;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.64);
      color: #665b48;
      font-size: 13px;
      font-weight: 650;
    }
    h1 {
      margin: 0 0 8px;
      font-size: clamp(30px, 6vw, 48px);
      line-height: 1.08;
      letter-spacing: 0;
    }
    .meta {
      color: #68635b;
      font-size: 14px;
    }
    .summary {
      margin-top: 16px;
      max-width: 720px;
      color: #33312d;
      font-size: 18px;
    }
    h2 {
      margin: 28px 0 10px;
      font-size: 23px;
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
    code {
      padding: 1px 5px;
      border-radius: 5px;
      background: rgba(0, 0, 0, 0.07);
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.92em;
    }
    .events {
      margin-top: 34px;
      padding: 18px 18px 14px;
      border: 1px solid #dfd3bf;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.62);
    }
    .events h2 { margin-top: 0; }
    .events ul { margin-bottom: 0; }
    .kanban-board {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
      align-items: start;
    }
    .kanban-column {
      min-height: 220px;
      padding: 12px;
      border: 1px solid #dfd3bf;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.58);
    }
    .kanban-column h2 {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin: 0 0 12px;
      font-size: 18px;
    }
    .kanban-count {
      min-width: 26px;
      padding: 2px 7px;
      border-radius: 999px;
      background: rgba(208, 120, 47, 0.14);
      color: #8f4f1e;
      text-align: center;
      font-size: 13px;
      font-weight: 700;
    }
    .kanban-cards {
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-height: 140px;
    }
    .kanban-card {
      padding: 10px 11px;
      border: 1px solid #ddd2c1;
      border-radius: 8px;
      background: #fffdf8;
      box-shadow: 0 1px 1px rgba(30, 24, 18, 0.04);
      cursor: grab;
      font-size: 15px;
    }
    .kanban-card:active { cursor: grabbing; }
    .kanban-empty,
    .kanban-footnote {
      color: #68635b;
      font-size: 14px;
    }
    .kanban-column.is-over {
      border-color: #d0782f;
      background: rgba(255, 246, 232, 0.82);
    }
    strong { font-weight: 700; }
    @media (max-width: 760px) {
      .kanban-board { grid-template-columns: 1fr; }
    }
    @media (prefers-color-scheme: dark) {
      body {
        background:
          linear-gradient(135deg, rgba(83, 167, 255, 0.15), transparent 34%),
          linear-gradient(315deg, rgba(255, 196, 87, 0.16), transparent 38%),
          #151515;
        color: #f2f0ea;
      }
      header { border-bottom-color: #3a3834; }
      .kicker {
        background: rgba(255, 255, 255, 0.08);
        border-color: #4b463d;
        color: #d9d0c2;
      }
      .meta { color: #aaa39a; }
      .summary { color: #e4ded3; }
      code { background: rgba(255, 255, 255, 0.12); }
      .events {
        background: rgba(255, 255, 255, 0.07);
        border-color: #4b463d;
      }
      .kanban-column {
        background: rgba(255, 255, 255, 0.07);
        border-color: #4b463d;
      }
      .kanban-card {
        background: rgba(255, 255, 255, 0.09);
        border-color: #4b463d;
      }
      .kanban-count {
        background: rgba(255, 196, 87, 0.15);
        color: #ffd693;
      }
      .kanban-empty,
      .kanban-footnote {
        color: #aaa39a;
      }
      .kanban-column.is-over {
        border-color: #d09a51;
        background: rgba(255, 196, 87, 0.10);
      }
    }
  </style>
</head>
<body class="${args.kind === 'agent_plan' ? 'agent-plan-theme' : ''}">
  <main>
    <header>
      <div class="kicker">${emoji} ${escapeHtml(label)}</div>
      <h1>${emoji} ${escapeHtml(args.title)}</h1>
      <div class="meta">${escapeHtml(createdLabel)} · ${escapeHtml(args.spaceId)}</div>
      ${args.summary ? `<p class="summary">${renderInline(args.summary)}</p>` : ''}
    </header>
    <section>
${renderBody(args.body, args.kind, args.spaceId)}
    </section>
  </main>
  ${
      args.kind === 'kanban_board'
          ? `<script>
    (() => {
      const board = document.querySelector('[data-kanban-board]');
      if (!board) return;
      const storageKey = 'pipi-kanban:' + location.pathname;
      const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
      const columns = [...board.querySelectorAll('[data-status]')];
      const cards = [...board.querySelectorAll('[data-card-id]')];
      const updateCounts = () => {
        for (const column of columns) {
          const count = column.querySelectorAll('[data-card-id]').length;
          const target = column.querySelector('.kanban-count');
          if (target) target.textContent = String(count);
          const empty = column.querySelector('.kanban-empty');
          if (empty) empty.hidden = count > 0;
        }
      };
      for (const card of cards) {
        const status = saved[card.dataset.cardId];
        const targetColumn = status && board.querySelector('[data-status="' + status + '"] .kanban-cards');
        if (targetColumn) targetColumn.appendChild(card);
        card.addEventListener('dragstart', (event) => {
          event.dataTransfer.setData('text/plain', card.dataset.cardId);
        });
      }
      for (const column of columns) {
        column.addEventListener('dragover', (event) => {
          event.preventDefault();
          column.classList.add('is-over');
        });
        column.addEventListener('dragleave', () => column.classList.remove('is-over'));
        column.addEventListener('drop', (event) => {
          event.preventDefault();
          column.classList.remove('is-over');
          const cardId = event.dataTransfer.getData('text/plain');
          const card = board.querySelector('[data-card-id="' + cardId + '"]');
          const cardList = column.querySelector('.kanban-cards');
          if (!card || !cardList) return;
          cardList.appendChild(card);
          saved[cardId] = column.dataset.status;
          localStorage.setItem(storageKey, JSON.stringify(saved));
          updateCounts();
        });
      }
      updateCounts();
    })();
  </script>`
          : ''
  }
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
            .substring(0, 52) || 'html-artifact'
    );
}

function buildUrl(fileName: string): string | null {
    const publicBaseUrl = (process.env.PIPI_PUBLIC_BASE_URL || PIPI_PUBLIC_BASE_URL).replace(/\/+$/, '');
    if (publicBaseUrl) {
        return `${publicBaseUrl}/html/${fileName}`;
    }

    return null;
}

export function normalizeHtmlArtifactKind(value: string | undefined): HtmlArtifactKind {
    const normalized = (value || 'brief').trim().toLowerCase();
    return HTML_ARTIFACT_KINDS.includes(normalized as HtmlArtifactKind) ? (normalized as HtmlArtifactKind) : 'brief';
}

export function getHtmlArtifactPath(fileName: string): string | null {
    if (!/^[a-z0-9][a-z0-9.-]*\.html$/.test(fileName)) {
        return null;
    }
    return path.join(HTML_ARTIFACT_DIR, fileName);
}

export function createHtmlArtifactPage(args: {
    spaceId: string;
    title: string;
    summary?: string;
    body: string;
    kind?: string;
    createdAt?: Date;
}): HtmlArtifactPage {
    ensureHtmlArtifactDir();
    const kind = normalizeHtmlArtifactKind(args.kind);
    const createdAt = args.createdAt || new Date();
    const day = createdAt.toISOString().slice(0, 10);
    const random = crypto.randomBytes(4).toString('hex');
    const fileName = `${day}-${kind}-${slugify(args.title)}-${random}.html`;
    const filePath = path.join(HTML_ARTIFACT_DIR, fileName);

    fs.writeFileSync(
        filePath,
        renderHtml({
            kind,
            title: args.title,
            summary: args.summary,
            body: args.body,
            spaceId: args.spaceId,
            createdAt,
        }),
        'utf8'
    );

    return {
        fileName,
        filePath,
        url: buildUrl(fileName),
    };
}

export function listHtmlArtifactPages(limit = 20): HtmlArtifactListEntry[] {
    ensureHtmlArtifactDir();
    return fs
        .readdirSync(HTML_ARTIFACT_DIR, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => {
            const filePath = path.join(HTML_ARTIFACT_DIR, entry.name);
            const stats = fs.statSync(filePath);
            return {
                fileName: entry.name,
                filePath,
                url: buildUrl(entry.name),
                size: stats.size,
                updatedAt: stats.mtime.toISOString(),
            };
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, Math.max(1, Math.min(limit, 100)));
}

export function taskBoardFileName(spaceId: string): string {
    const hash = crypto.createHash('sha256').update(spaceId).digest('hex').slice(0, 12);
    return `task-board-${hash}.html`;
}

export function taskBoardFilePath(spaceId: string): string {
    return path.join(HTML_ARTIFACT_DIR, taskBoardFileName(spaceId));
}

export function generateTaskBoard(spaceId: string): HtmlArtifactPage {
    ensureHtmlArtifactDir();
    const fileName = taskBoardFileName(spaceId);
    const filePath = path.join(HTML_ARTIFACT_DIR, fileName);

    fs.writeFileSync(
        filePath,
        renderHtml({
            kind: 'task_board',
            title: 'Task Board',
            body: '',
            spaceId,
            createdAt: new Date(),
        }),
        'utf8'
    );

    return {
        fileName,
        filePath,
        url: buildUrl(fileName),
    };
}
