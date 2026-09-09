import type { AgentOnboardingState } from './service';

function escapeHtml(value: unknown): string {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function safeJson(value: unknown): string {
    return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
}

function displayValue(value: unknown): string {
    if (Array.isArray(value)) return value.length ? value.map(escapeHtml).join('<br>') : 'Not set / Не задано';
    return value === undefined || value === '' ? 'Not set / Не задано' : escapeHtml(value);
}

export function renderAgentOnboardingReviewPage(input: { state: AgentOnboardingState; csrfToken: string }): string {
    const preview = input.state.preview;
    const canConfirm = preview?.state === 'awaiting_confirmation';
    const labels = {
        language: 'Language / Язык',
        timezone: 'Time zone / Часовой пояс',
        displayName: 'Name / Имя',
        facts: 'Facts to remember / Что запомнить',
        currentTask: 'First task / Первая задача',
    };
    const title = preview
        ? 'Review owner context / Проверка контекста владельца'
        : 'Owner context / Контекст владельца';
    const previewRows = preview
        ? `
        <h2>What PiPi will remember / Что запомнит PiPi</h2>
        <dl>${Object.entries(labels)
            .map(
                ([field, label]) =>
                    `<dt>${label}</dt><dd>${displayValue(preview.ownerContext[field as keyof typeof labels])}</dd>`
            )
            .join('')}</dl>
        <h2>Changes / Изменения</h2>
        ${preview.diff.length ? `<table><thead><tr><th>Field / Поле</th><th>Before / Было</th><th>After / Станет</th></tr></thead><tbody>${preview.diff.map((change) => `<tr><th>${labels[change.field]}</th><td>${displayValue(change.before)}</td><td>${displayValue(change.after)}</td></tr>`).join('')}</tbody></table>` : '<p>No changes / Без изменений</p>'}
        <p>These details are saved on this computer. PiPi reads them when it next starts.<br>Данные сохранятся на этом компьютере. PiPi прочитает их при следующем запуске.</p>
        ${preview.state === 'expired' ? '<p role="status">This proposal expired. Ask your agent for a new preview.<br>Предложение истекло. Попросите агента подготовить новое.</p>' : ''}
        ${preview.state === 'applied' ? `<p role="status">${input.state.currentMatchesPreview === false ? 'Previously saved; the current context has changed.<br>Ранее сохранено; с тех пор контекст изменился.' : 'Saved locally / Сохранено локально'}</p>` : ''}
        <details><summary>Proposal details / Данные предложения</summary><dl>
          <dt>Preview ID</dt><dd><code>${escapeHtml(preview.previewId)}</code></dd>
          <dt>Hash</dt><dd><code>${escapeHtml(preview.previewHash)}</code></dd>
          <dt>Expires / Истекает</dt><dd>${escapeHtml(preview.expiresAt)}</dd>
          <dt>Base revision</dt><dd>${escapeHtml(preview.baseRevision ?? 'none')}</dd>
        </dl><pre>${escapeHtml(JSON.stringify(preview.effects, null, 2))}</pre></details>
        ${canConfirm ? '<button id="confirm" type="button">Confirm and save / Подтвердить и сохранить</button><noscript><p>Enable JavaScript to confirm in this private page. Nothing has been saved.</p></noscript>' : ''}
        <p id="result" role="status" aria-live="polite"></p>`
        : `<p>No pending preview was found. / Ожидающий подтверждения preview не найден.</p>`;
    const client =
        preview && canConfirm
            ? `<script>
const csrfToken = ${safeJson(input.csrfToken)};
const previewId = ${safeJson(preview.previewId)};
const previewHash = ${safeJson(preview.previewHash)};
const idempotencyKey = 'confirm:' + previewId + ':' + previewHash;
document.getElementById('confirm').addEventListener('click', async () => {
  const button = document.getElementById('confirm');
  const result = document.getElementById('result');
  button.disabled = true;
  result.textContent = 'Saving / Сохраняю…';
  try {
    const response = await fetch('/api/agent-onboarding/confirm', {
      method: 'POST', credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-PiPi-CSRF': csrfToken},
      body: JSON.stringify({previewId, previewHash, idempotencyKey})
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Save failed');
    result.textContent = 'Saved locally / Сохранено локально';
    button.remove();
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : 'Save failed';
    button.disabled = false;
  }
});
</script>`
            : '';
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#172033;background:#fff}h1,h2{line-height:1.2}dl{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:8px 16px}dt{font-weight:700}dd{margin:0;overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f5f8;padding:16px;border-radius:8px}button{font:inherit;padding:12px 18px;margin-top:20px;background:#256b4b;color:white;border:0;border-radius:8px;cursor:pointer}button:disabled{opacity:.6;cursor:wait}code{overflow-wrap:anywhere}table{width:100%;border-collapse:collapse;table-layout:fixed}th,td{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #dce2e8;overflow-wrap:anywhere}details{margin-top:20px}summary{cursor:pointer}button:focus-visible,summary:focus-visible{outline:3px solid #3587ce;outline-offset:3px}
</style></head><body><main><h1>${escapeHtml(title)}</h1>
<p>This saves local personalization only. It does not start Telegram, providers, or the runtime.<br>Сохраняется только локальная персонализация. Telegram, провайдеры и runtime не запускаются.</p>
${previewRows}</main>${client}</body></html>`;
}
