import type { SetupSafeStatus } from './service';

export type SetupPageState = SetupSafeStatus;

export type SetupPageOptions = {
    status: SetupPageState;
    csrfToken: string;
};

function safeJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
        const codePoint = character.codePointAt(0);
        return codePoint === undefined ? '' : `\\u${codePoint.toString(16).padStart(4, '0')}`;
    });
}

export function renderSetupPage(options: SetupPageOptions): string {
    const state = options.status;
    const sessionToken = options.csrfToken;
    const initialState = safeJson(state);
    const setupToken = safeJson(sessionToken);

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark light">
  <title>Set up Open PiPi</title>
  <style>
    :root { color-scheme: dark; --bg:#12131a; --panel:#1b1d27; --line:#2b2e3d; --text:#e6e7ee; --muted:#9aa0b4; --accent:#6ea8fe; --accent2:#9b8cff; --ok:#6ee7a8; --danger:#ff9090; --warn:#ffd37a; --shadow:0 22px 70px rgba(0,0,0,.25); }
    @media (prefers-color-scheme:light) { :root { color-scheme:light; --bg:#f4f5f9; --panel:#fff; --line:#dfe2ec; --text:#1c1e27; --muted:#62687c; --accent:#2b6cb0; --accent2:#6b5bd2; --ok:#1a7f52; --danger:#b3261e; --warn:#8a5a00; --shadow:0 20px 60px rgba(43,48,68,.12); } }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 50% -20%, color-mix(in srgb, var(--accent) 18%, transparent), transparent 42%),var(--bg); color:var(--text); font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; }
    button,input,select,textarea { font:inherit; }
    button,a { -webkit-tap-highlight-color:transparent; }
    main { width:min(720px,calc(100% - 28px)); margin:0 auto; padding:38px 0 64px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
    .brand { display:flex; align-items:center; gap:11px; font-weight:750; letter-spacing:-.01em; }
    .mark { display:grid; place-items:center; width:34px; height:34px; border-radius:11px; background:linear-gradient(145deg,var(--accent),var(--accent2)); color:white; font-weight:900; box-shadow:0 8px 26px color-mix(in srgb,var(--accent) 24%,transparent); }
    .language { display:flex; padding:3px; border:1px solid var(--line); border-radius:9px; background:var(--panel); }
    .language button { margin:0; padding:5px 9px; border:0; border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; }
    .language button[aria-pressed=true] { background:color-mix(in srgb,var(--accent) 16%,transparent); color:var(--text); }
    .intro { margin-bottom:18px; padding:24px; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line)); border-radius:16px; background:linear-gradient(140deg,color-mix(in srgb,var(--panel) 94%,var(--accent)),var(--panel)); box-shadow:var(--shadow); }
    h1 { margin:0 0 7px; font-size:clamp(1.45rem,4vw,2rem); letter-spacing:-.035em; line-height:1.18; }
    h2 { margin:0; font-size:1.04rem; letter-spacing:-.01em; }
    p { margin:.45rem 0; }
    .intro p,.muted,.help { color:var(--muted); }
    .jeeves { display:flex; gap:12px; align-items:flex-start; margin-top:18px; padding:14px; border-radius:12px; background:color-mix(in srgb,var(--accent) 9%,transparent); }
    .jeeves-icon { flex:none; font-size:1.35rem; line-height:1.4; }
    .jeeves strong { display:block; color:var(--text); }
    .jeeves p { margin:.2rem 0 0; font-size:.91rem; }
    .progress { display:grid; grid-template-columns:repeat(4,1fr); gap:6px; margin:0 2px 18px; }
    .progress span { height:4px; border-radius:4px; background:var(--line); }
    .progress span.done { background:var(--ok); }
    .progress span.current { background:var(--accent); }
    .card { margin-top:10px; padding:18px; border:1px solid var(--line); border-radius:14px; background:var(--panel); }
    .card.locked { opacity:.52; }
    .card-head { display:flex; align-items:center; gap:11px; }
    .number { display:grid; place-items:center; flex:none; width:27px; height:27px; border:1px solid var(--line); border-radius:50%; color:var(--muted); font-size:.82rem; font-weight:700; }
    .card.done .number { border-color:color-mix(in srgb,var(--ok) 55%,var(--line)); background:color-mix(in srgb,var(--ok) 12%,transparent); color:var(--ok); }
    .status { margin-left:auto; padding:3px 8px; border-radius:99px; background:color-mix(in srgb,var(--muted) 12%,transparent); color:var(--muted); font-size:.76rem; }
    .status.ok { background:color-mix(in srgb,var(--ok) 12%,transparent); color:var(--ok); }
    .status.bad { background:color-mix(in srgb,var(--danger) 12%,transparent); color:var(--danger); }
    .body { margin:13px 0 0 38px; }
    .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:13px; }
    button,.button { display:inline-flex; align-items:center; justify-content:center; min-height:39px; padding:8px 13px; border:0; border-radius:9px; background:var(--accent); color:white; text-decoration:none; cursor:pointer; font-weight:650; }
    button.secondary,.button.secondary { border:1px solid var(--line); background:transparent; color:var(--text); font-weight:550; }
    button.danger { border:1px solid color-mix(in srgb,var(--danger) 45%,var(--line)); background:transparent; color:var(--danger); }
    button:disabled { cursor:wait; opacity:.55; }
    details { margin-top:12px; }
    summary { color:var(--accent); cursor:pointer; }
    form { display:grid; gap:7px; margin-top:10px; }
    fieldset { display:grid; gap:7px; min-width:0; margin:0; padding:0; border:0; }
    label { color:var(--muted); font-size:.84rem; }
    input,select,textarea { width:100%; min-height:40px; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--text); }
    textarea { min-height:82px; resize:vertical; }
    input:focus,select:focus,textarea:focus,button:focus-visible,a:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
    .consent { display:flex; align-items:flex-start; gap:8px; color:var(--text); }
    .consent input { width:auto; min-height:0; margin-top:4px; }
    .row { display:grid; grid-template-columns:1fr 1fr auto; gap:8px; align-items:end; }
    .row button { margin-bottom:0; }
    .guide { padding-left:20px; color:var(--muted); }
    .guide li { margin:.3rem 0; }
    code { color:var(--text); }
    .issue { margin:14px 0 0 38px; padding:10px 12px; border:1px solid color-mix(in srgb,var(--danger) 42%,var(--line)); border-radius:9px; color:var(--danger); background:color-mix(in srgb,var(--danger) 7%,transparent); }
    .issue button { min-height:31px; margin-top:8px; padding:4px 9px; }
    .candidate { margin-top:12px; padding:11px 12px; border:1px solid color-mix(in srgb,var(--accent) 45%,var(--line)); border-radius:9px; }
    .footer { margin-top:20px; text-align:center; color:var(--muted); font-size:.8rem; }
    .live { min-height:1.5em; margin-top:12px; text-align:center; color:var(--ok); }
    @media (max-width:560px) { main { padding-top:20px; } .intro { padding:19px; } .card { padding:15px; } .body,.issue { margin-left:0; } .row { grid-template-columns:1fr; } .row button { width:100%; } }
  </style>
</head>
<body>
<main>
  <noscript><p class="issue">JavaScript is required for private setup. No credentials can be submitted while it is disabled.</p></noscript>
  <header class="top">
    <div class="brand"><span class="mark">P</span><span>Open PiPi</span></div>
    <div class="language" aria-label="Language">
      <button type="button" data-language="en" aria-pressed="true">EN</button>
      <button type="button" data-language="ru" aria-pressed="false">RU</button>
    </div>
  </header>

  <section class="intro">
    <h1 data-i18n="title">Your PiPi, ready in a few steps</h1>
    <p data-i18n="subtitle">Connect the services privately on this computer. You can leave and continue later.</p>
    <div class="jeeves">
      <span class="jeeves-icon" aria-hidden="true">🎩</span>
      <div>
        <strong data-i18n="jeevesTitle">PiPi starts as Jeeves — your personal assistant.</strong>
        <p data-i18n="jeevesBody">You can change its character, standing rules and role later. Try “be more concise”, “always ask before booking”, or use <code>/pack</code> to see available specializations.</p>
        <p id="current-character" hidden></p>
      </div>
    </div>
  </section>

  <div class="progress" aria-hidden="true"><span></span><span></span><span></span><span></span></div>
  <p id="runtime-edit-note" class="help" hidden data-i18n="stopToEdit">Stop PiPi before changing AI, Telegram, or owner connection settings.</p>
  <div id="page-issue" class="issue" role="alert" hidden></div>

  <section class="card" id="step-ai">
    <div class="card-head"><span class="number">1</span><h2 data-i18n="aiTitle">Connect AI</h2><span class="status">Waiting</span></div>
    <div class="body">
      <p data-i18n="aiBody">OpenRouter provides access to the AI models PiPi uses. Model usage is billed by OpenRouter, separately from ChatGPT or Claude subscriptions.</p>
      <div class="actions">
        <button type="button" data-action="oauth" data-i18n="oauth">Connect OpenRouter</button>
        <button type="button" class="secondary" data-action="validate" data-i18n="checkAgain">Check again</button>
      </div>
      <details>
        <summary data-i18n="existingKey">Use an existing API key</summary>
        <form id="key-form" method="post" action="/" autocomplete="off">
          <fieldset disabled>
            <label for="openrouter-key" data-i18n="keyLabel">OpenRouter API key</label>
            <input id="openrouter-key" type="password" name="key" autocomplete="off" spellcheck="false" required>
            <p class="help" data-i18n="privateKey">The key goes directly to this local PiPi process. It is never shown to your coding agent.</p>
            <button type="submit" data-i18n="saveCheck">Save and check</button>
          </fieldset>
        </form>
      </details>
    </div>
  </section>

  <section class="card" id="step-telegram">
    <div class="card-head"><span class="number">2</span><h2 data-i18n="telegramTitle">Connect Telegram</h2><span class="status">Waiting</span></div>
    <div class="body">
      <ol class="guide">
        <li><a href="https://t.me/BotFather" target="_blank" rel="noreferrer" data-i18n="botfatherOpen">Open BotFather in Telegram</a>.</li>
        <li data-i18n="botfatherCreate">Send <code>/newbot</code>, then choose a name and username.</li>
        <li data-i18n="botfatherPaste">Copy the token BotFather gives you and paste it privately below.</li>
      </ol>
      <form id="telegram-form" method="post" action="/" autocomplete="off">
        <fieldset disabled>
          <label for="telegram-token" data-i18n="telegramToken">Telegram bot token</label>
          <input id="telegram-token" type="password" name="token" autocomplete="off" spellcheck="false" required>
          <button type="submit" data-i18n="connectBot">Connect bot</button>
        </fieldset>
      </form>
    </div>
  </section>

  <section class="card" id="step-owner">
    <div class="card-head"><span class="number">3</span><h2 data-i18n="ownerTitle">Link your account</h2><span class="status">Waiting</span></div>
    <div class="body">
      <p id="owner-instructions" data-i18n="ownerBody">Open the one-time link and press Start in the private chat. Return here to confirm the account PiPi found.</p>
      <p id="owner-linked" hidden data-i18n="ownerLinked">Your Telegram account is linked.</p>
      <div class="actions">
        <button type="button" data-action="pair" data-i18n="makeLink">Create private link</button>
        <a id="pair-link" class="button" target="_blank" rel="noreferrer" hidden data-i18n="openPipi">Open my PiPi</a>
      </div>
      <div id="candidate" class="candidate" hidden>
        <strong id="candidate-name"></strong>
        <p class="muted" data-i18n="candidatePrompt">Is this your Telegram account?</p>
        <div class="actions"><button type="button" data-action="confirm-owner" data-i18n="thisIsMe">This is me</button><button type="button" class="secondary" data-action="cancel-pair" data-i18n="notMe">Not me</button></div>
      </div>
    </div>
  </section>

  <section class="card" id="step-runtime">
    <div class="card-head"><span class="number">4</span><h2 data-i18n="runtimeTitle">Try your PiPi</h2><span class="status">Waiting</span></div>
    <div class="body">
      <p data-i18n="runtimeBody">Start PiPi here, then send it a message in Telegram. The setup page only calls it ready after the connection checks pass.</p>
      <p id="runtime-mode-status" class="help" data-i18n="runtimeStopped">PiPi is stopped.</p>
      <div class="actions">
        <button type="button" data-action="start-foreground" data-i18n="tryNow">Try now</button>
        <button type="button" class="secondary" data-action="start-background" data-i18n="background">Keep running in background</button>
        <button type="button" class="danger" data-action="stop" data-i18n="stop">Stop PiPi</button>
      </div>
      <p id="background-note" class="help" data-i18n="sleep">Background mode keeps PiPi running after this setup closes and after you sign in. It cannot work while this computer is asleep or turned off.</p>
    </div>
  </section>

  <section class="card" id="preferences">
    <div class="card-head"><span class="number">·</span><h2 data-i18n="preferences">Language and time</h2></div>
    <div class="body">
      <form id="metadata-form" method="post" action="/">
        <div class="row">
          <label><span data-i18n="languageLabel">Conversation language</span><select name="language"><option value="en">English</option><option value="ru">Русский</option></select></label>
          <label><span data-i18n="timezoneLabel">Time zone</span><input name="timezone" required></label>
          <button type="submit" class="secondary" data-i18n="save">Save</button>
        </div>
        <p class="help" data-i18n="metadataHelp">Suggested from this browser. You can change either later.</p>
      </form>
      <details id="profile-card">
        <summary data-i18n="profileSummary">Optional: tell PiPi a little about you</summary>
        <form id="profile-form" method="post" action="/">
          <p class="help" data-i18n="profileHelp">Add up to five short facts, one per line, and a current task. Leave this empty to skip it.</p>
          <label><span data-i18n="factsLabel">Useful facts</span><textarea name="facts" maxlength="1204" data-i18n-placeholder="factsPlaceholder" placeholder="I prefer concise answers"></textarea></label>
          <label><span data-i18n="taskLabel">Current task</span><textarea name="currentTask" maxlength="500" data-i18n-placeholder="taskPlaceholder" placeholder="Help me plan this week"></textarea></label>
          <label class="consent"><input type="checkbox" name="consent" required><span data-i18n="profileConsent">Save these details in my private PiPi memory.</span></label>
          <button type="submit" class="secondary" data-i18n="saveProfile">Save optional context</button>
          <p id="profile-present" class="help" hidden data-i18n="profilePresent">PiPi already has private owner context. Empty fields here leave it unchanged.</p>
        </form>
      </details>
    </div>
  </section>

  <p class="footer" data-i18n="localOnly">This setup page is available only on this computer.</p>
  <p id="live" class="live" aria-live="polite"></p>
</main>
<script>
(() => {
  'use strict';
  let state = ${initialState};
  const sessionToken = ${setupToken};
  let busy = false;
  document.querySelectorAll('#key-form fieldset,#telegram-form fieldset').forEach((fieldset) => { fieldset.disabled = false; });
  let selectedLanguage = state.language || state.metadata?.language || ((navigator.language || 'en').toLowerCase().startsWith('ru') ? 'ru' : 'en');
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const strings = {
    en: { title:'Your PiPi, ready in a few steps',subtitle:'Connect the services privately on this computer. You can leave and continue later.',jeevesTitle:'PiPi starts as Jeeves — your personal assistant.',jeevesBody:'You can change its character, standing rules and role later. Try “be more concise”, “always ask before booking”, or use /pack to see available specializations.',currentCharacter:'Current character: {name}. Your existing choice is preserved.',aiTitle:'Connect AI',aiBody:'OpenRouter provides access to the AI models PiPi uses. Model usage is billed by OpenRouter, separately from ChatGPT or Claude subscriptions.',oauth:'Connect OpenRouter',checkAgain:'Check again',existingKey:'Use an existing API key',keyLabel:'OpenRouter API key',privateKey:'The key goes directly to this local PiPi process. It is never shown to your coding agent.',saveCheck:'Save and check',telegramTitle:'Connect Telegram',botfatherOpen:'Open BotFather in Telegram',botfatherCreate:'Send /newbot, then choose a name and username.',botfatherPaste:'Copy the token BotFather gives you and paste it privately below.',telegramToken:'Telegram bot token',connectBot:'Connect bot',ownerTitle:'Link your account',ownerBody:'Open the one-time link and press Start in the private chat. Return here to confirm the account PiPi found.',ownerLinked:'Your Telegram account is linked.',makeLink:'Create private link',openPipi:'Open my PiPi',candidatePrompt:'Is this your Telegram account?',thisIsMe:'This is me',notMe:'Not me',runtimeTitle:'Try your PiPi',runtimeBody:'Start PiPi here, then send it a message in Telegram. The setup page only calls it ready after a real reply is observed.',runtimeStopped:'PiPi is stopped.',runtimeStarting:'PiPi is starting…',runtimeForeground:'Temporary mode is running. Keep this setup command open.',runtimeBackground:'Background mode is active. You can close this setup.',tryNow:'Try now',background:'Keep running in background',stop:'Stop PiPi',sleep:'Background mode keeps PiPi running after this setup closes and after you sign in. It cannot work while this computer is asleep or turned off.',stopToEdit:'Stop PiPi before changing AI, Telegram, or owner connection settings.',preferences:'Language and time',languageLabel:'Conversation language',timezoneLabel:'Time zone',save:'Save',metadataHelp:'Suggested from this browser. You can change either later.',profileSummary:'Optional: tell PiPi a little about you',profileHelp:'Add up to five short facts, one per line, and a current task. Leave this empty to skip it.',factsLabel:'Useful facts',factsPlaceholder:'I prefer concise answers',taskLabel:'Current task',taskPlaceholder:'Help me plan this week',profileConsent:'Save these details in my private PiPi memory.',saveProfile:'Save optional context',profilePresent:'PiPi already has private owner context. Empty fields here leave it unchanged.',localOnly:'This setup page is available only on this computer.',waiting:'Waiting',checking:'Checking…',ready:'Ready',connected:'Connected',running:'Running',stopped:'Stopped',problem:'Needs attention',retry:'Retry this step',opening:'Opening OpenRouter…',saved:'Saved.',savedRestart:'Saved. Restart PiPi to apply these changes.',existingOwner:'An owner is already linked. PiPi will not replace it.',notSupported:'Background mode is not supported on this system.',verifyFirst:'Send a message to PiPi and wait for its reply before choosing background mode.'},
    ru: { title:'Ваш PiPi — ещё несколько шагов',subtitle:'Подключите сервисы приватно на этом компьютере. Можно закрыть страницу и продолжить позже.',jeevesTitle:'PiPi начинает как Дживс — ваш личный ассистент.',jeevesBody:'Позже можно изменить его характер, постоянные правила и роль. Например: «отвечай короче», «всегда спрашивай перед бронированием»; команда /pack покажет доступные специализации.',currentCharacter:'Текущий характер: {name}. Ваш прежний выбор сохранён.',aiTitle:'Подключите AI',aiBody:'OpenRouter предоставляет доступ к AI-моделям PiPi. Использование моделей оплачивается в OpenRouter отдельно от подписок ChatGPT или Claude.',oauth:'Подключить OpenRouter',checkAgain:'Проверить снова',existingKey:'Использовать существующий API-ключ',keyLabel:'API-ключ OpenRouter',privateKey:'Ключ передаётся прямо локальному процессу PiPi. Coding agent его не увидит.',saveCheck:'Сохранить и проверить',telegramTitle:'Подключите Telegram',botfatherOpen:'Откройте BotFather в Telegram',botfatherCreate:'Отправьте /newbot, затем выберите имя и username.',botfatherPaste:'Скопируйте выданный BotFather токен и приватно вставьте ниже.',telegramToken:'Токен Telegram-бота',connectBot:'Подключить бота',ownerTitle:'Привяжите свой аккаунт',ownerBody:'Откройте одноразовую ссылку и нажмите Start в личном чате. Вернитесь сюда, чтобы подтвердить найденный аккаунт.',ownerLinked:'Ваш аккаунт Telegram привязан.',makeLink:'Создать личную ссылку',openPipi:'Открыть моего PiPi',candidatePrompt:'Это ваш аккаунт Telegram?',thisIsMe:'Это я',notMe:'Не я',runtimeTitle:'Попробуйте PiPi',runtimeBody:'Запустите PiPi здесь и напишите ему в Telegram. Страница назовёт подключение готовым только после фактического ответа.',runtimeStopped:'PiPi остановлен.',runtimeStarting:'PiPi запускается…',runtimeForeground:'Временный режим работает. Не закрывайте команду настройки.',runtimeBackground:'Фоновый режим работает. Настройку можно закрыть.',tryNow:'Попробовать сейчас',background:'Оставить работать в фоне',stop:'Остановить PiPi',sleep:'Фоновый режим продолжает работу после закрытия настройки и после входа в систему. PiPi не работает, пока компьютер спит или выключен.',stopToEdit:'Остановите PiPi, прежде чем менять настройки AI, Telegram или владельца.',preferences:'Язык и время',languageLabel:'Язык общения',timezoneLabel:'Часовой пояс',save:'Сохранить',metadataHelp:'Предложено по настройкам браузера. Позже можно изменить.',profileSummary:'Необязательно: немного расскажите PiPi о себе',profileHelp:'Добавьте до пяти коротких фактов, по одному в строке, и текущую задачу. Можно оставить поля пустыми.',factsLabel:'Полезные факты',factsPlaceholder:'Я предпочитаю краткие ответы',taskLabel:'Текущая задача',taskPlaceholder:'Помоги спланировать эту неделю',profileConsent:'Сохранить эти сведения в моей личной памяти PiPi.',saveProfile:'Сохранить необязательный контекст',profilePresent:'У PiPi уже есть личный контекст владельца. Пустые поля останутся без изменений.',localOnly:'Эта страница настройки доступна только на этом компьютере.',waiting:'Ожидание',checking:'Проверка…',ready:'Готово',connected:'Подключено',running:'Работает',stopped:'Остановлен',problem:'Нужно действие',retry:'Повторить этот шаг',opening:'Открываем OpenRouter…',saved:'Сохранено.',savedRestart:'Сохранено. Перезапустите PiPi, чтобы применить изменения.',existingOwner:'Владелец уже привязан. PiPi не заменит его.',notSupported:'Фоновый режим не поддерживается в этой системе.',verifyFirst:'Сначала напишите PiPi и дождитесь его ответа, затем выберите фоновый режим.'}
  };
  const t = (key) => strings[selectedLanguage]?.[key] || strings.en[key] || key;
  const savedMessage = () => t(state.metadata?.preferencesPending ? 'savedRestart' : 'saved');
  function statusValue(kind) {
    if (kind === 'ai') {
      if (state.provider?.status) return state.provider.status;
      if (state.provider?.validated) return 'ready';
      return state.provider?.configured ? 'checking' : 'missing';
    }
    if (kind === 'telegram') {
      if (state.telegram?.status) return state.telegram.status;
      if (state.telegram?.validated) return 'ready';
      return state.telegram?.configured ? 'checking' : 'missing';
    }
    if (kind === 'owner') {
      if (state.owners?.existing || (state.owners?.count || 0) > 0) return 'ready';
      if (state.pairing?.candidate) return 'candidate';
      return state.pairing?.active ? 'pairing' : 'missing';
    }
    if (state.runtime?.dialogueVerified) return 'ready';
    if (state.runtime?.state === 'ready') return 'running';
    return state.runtime?.state || 'stopped';
  }

  function isReady(kind) {
    const value = statusValue(kind);
    if (kind === 'runtime') return value === 'ready';
    return value === 'ready';
  }

  function labelFor(value) {
    if (['ready','validated'].includes(value)) return t('ready');
    if (['checking','starting','pairing','candidate'].includes(value)) return t('checking');
    if (['error','problem','failed'].includes(value)) return t('problem');
    if (value === 'running') return t('running');
    if (value === 'stopped') return t('stopped');
    return t('waiting');
  }

  function setLanguage(language) {
    selectedLanguage = language === 'ru' ? 'ru' : 'en';
    document.documentElement.lang = selectedLanguage;
    document.querySelectorAll('[data-language]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.language === selectedLanguage)));
    document.querySelectorAll('[data-i18n]').forEach((element) => { const key = element.dataset.i18n; if (key && t(key)) element.textContent = t(key); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((element) => { const key = element.dataset.i18nPlaceholder; if (key && t(key)) element.placeholder = t(key); });
    document.querySelector('#metadata-form select[name=language]').value = selectedLanguage;
    render();
  }

  function render() {
    const order = ['ai','telegram','owner','runtime'];
    const unlocked = [true, isReady('ai'), isReady('ai') && isReady('telegram'), isReady('ai') && isReady('telegram') && isReady('owner')];
    const runtimeActive = ['ready','starting'].includes(state.runtime?.state);
    order.forEach((kind,index) => {
      const card = document.getElementById('step-' + kind);
      const value = statusValue(kind);
      card.classList.toggle('done', isReady(kind));
      card.classList.toggle('locked', !unlocked[index]);
      card.querySelectorAll('button,input').forEach((control) => { control.disabled = busy || !unlocked[index] || (runtimeActive && kind !== 'runtime'); });
      const badge = card.querySelector('.status');
      badge.textContent = labelFor(value);
      badge.className = 'status' + (isReady(kind) ? ' ok' : ['error','problem','failed'].includes(value) ? ' bad' : '');
    });
    const progress = document.querySelectorAll('.progress span');
    order.forEach((kind,index) => { progress[index].className = isReady(kind) ? 'done' : unlocked[index] ? 'current' : ''; });

    const character = state.profile;
    const current = character?.currentPack;
    const characterNote = document.getElementById('current-character');
    if (current && (current !== (character.initialPack || 'jeeves') || character.customized)) {
      characterNote.hidden = false;
      characterNote.textContent = t('currentCharacter').replace('{name}', current);
    } else characterNote.hidden = true;
    document.getElementById('profile-present').hidden = state.metadata?.profilePresent !== true;
    document.getElementById('runtime-edit-note').hidden = !runtimeActive;

    const bot = state.telegram?.bot?.username || state.telegram?.bot?.firstName;
    const telegramBody = document.querySelector('#step-telegram .body > .guide');
    if (bot && isReady('telegram')) telegramBody.setAttribute('aria-label', '@' + String(bot).replace(/^@/, '') + ' connected');

    const link = state.pairing?.link;
    const linkElement = document.getElementById('pair-link');
    linkElement.hidden = !link;
    if (link) linkElement.href = link;
    const candidate = state.pairing?.candidate;
    const ownerReady = isReady('owner');
    document.querySelector('[data-action=pair]').hidden = ownerReady;
    document.getElementById('owner-instructions').hidden = ownerReady;
    document.getElementById('owner-linked').hidden = !ownerReady;
    document.getElementById('candidate').hidden = !candidate;
    if (candidate) document.getElementById('candidate-name').textContent = candidate.displayName || (candidate.username ? '@' + candidate.username : 'Telegram account');

    const backgroundButton = document.querySelector('[data-action=start-background]');
    const foregroundButton = document.querySelector('[data-action=start-foreground]');
    const supported = state.background?.supported !== false;
    const dialogueVerified = state.runtime?.dialogueVerified === true;
    const backgroundActive = runtimeActive && state.runtime?.mode === 'background';
    foregroundButton.disabled = busy || !unlocked[3] || runtimeActive;
    backgroundButton.disabled = busy || !unlocked[3] || !supported || !dialogueVerified || backgroundActive;
    backgroundButton.title = !supported ? t('notSupported') : !dialogueVerified ? t('verifyFirst') : '';
    const modeStatus = document.getElementById('runtime-mode-status');
    modeStatus.textContent =
      state.runtime?.state === 'starting' ? t('runtimeStarting') :
      state.runtime?.state === 'ready' && state.runtime?.mode === 'background' ? t('runtimeBackground') :
      state.runtime?.state === 'ready' ? t('runtimeForeground') :
      state.runtime?.state === 'error' ? (state.runtime.message || t('problem')) : t('runtimeStopped');
    const stopButton = document.querySelector('[data-action=stop]');
    stopButton.disabled = busy || state.runtime?.state === 'stopped';
    if (state.background?.explanation) document.getElementById('background-note').textContent = state.background.explanation;

    const issue = state.issue;
    const issueElement = document.getElementById('page-issue');
    issueElement.replaceChildren();
    if (issue?.message) {
      issueElement.hidden = false;
      issueElement.append(document.createTextNode(issue.message));
      if (issue.action) issueElement.append(document.createElement('br'), document.createTextNode(issue.action));
      if (issue.retryable !== false) {
        const retry = document.createElement('button');
        retry.type = 'button'; retry.className = 'secondary'; retry.dataset.action = 'retry'; retry.textContent = t('retry');
        issueElement.append(document.createElement('br'), retry);
      }
    } else issueElement.hidden = true;
  }

  async function request(path, body = {}) {
    if (busy) return null;
    busy = true; state.issue = undefined; render();
    try {
      const response = await fetch(path, { method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json','X-PiPi-CSRF':sessionToken}, body:JSON.stringify(body) });
      const result = await response.json().catch(() => ({}));
      if (result.state) state = result.state;
      if (!response.ok || result.error) state.issue = result.error || { message:'The local setup service could not complete this step.', retryable:true };
      return result;
    } catch (_) {
      state.issue = { message:selectedLanguage === 'ru' ? 'Локальная служба настройки недоступна. Запустите pnpm setup снова.' : 'The local setup service is unavailable. Run pnpm setup again.', retryable:true };
      return null;
    } finally { busy = false; render(); }
  }

  async function refresh() {
    try {
      const response = await fetch('/api/status', { credentials:'same-origin', cache:'no-store' });
      if (response.ok) state = await response.json();
      render();
    } catch (_) { /* the current state remains useful while the helper restarts */ }
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-language],[data-action]');
    if (!button) return;
    if (button.dataset.language) { setLanguage(button.dataset.language); return; }
    const action = button.dataset.action;
    if (action === 'oauth') { const result = await request('/api/openrouter/oauth'); if (result?.authorizationUrl) { document.getElementById('live').textContent = t('opening'); location.assign(result.authorizationUrl); } }
    if (action === 'validate') await request('/api/connections/validate');
    if (action === 'pair') await request('/api/pairing/start');
    if (action === 'confirm-owner') { const candidate = state.pairing?.candidate; if (candidate) await request('/api/pairing/confirm', { candidateId:candidate.id }); }
    if (action === 'cancel-pair') await request('/api/pairing/cancel');
    if (action === 'start-foreground') await request('/api/runtime/start', { mode:'foreground' });
    if (action === 'start-background') await request('/api/runtime/start', { mode:'background' });
    if (action === 'stop') await request('/api/runtime/stop');
    if (action === 'retry') await request('/api/retry', { target:state.issue?.target || state.phase || 'provider' });
  });

  document.getElementById('key-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = document.getElementById('openrouter-key'); await request('/api/openrouter/key', { key:input.value }); input.value = ''; });
  document.getElementById('telegram-form').addEventListener('submit', async (event) => { event.preventDefault(); const input = document.getElementById('telegram-token'); await request('/api/telegram', { token:input.value }); input.value = ''; });
  document.getElementById('metadata-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const result = await request('/api/metadata', { language:String(form.get('language') || ''), timezone:String(form.get('timezone') || '') }); if (result && !result.error) document.getElementById('live').textContent = savedMessage(); });
  document.getElementById('profile-form').addEventListener('submit', async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); if (form.get('consent') !== 'on') return; const facts = String(form.get('facts') || '').split(/\\r?\\n/).map((fact) => fact.trim()).filter(Boolean); const result = await request('/api/profile', { consent:true, language:String(document.querySelector('#metadata-form select[name=language]').value || ''), timezone:String(document.querySelector('#metadata-form input[name=timezone]').value || ''), facts, currentTask:String(form.get('currentTask') || '') }); if (result && !result.error) { formElement.reset(); document.getElementById('live').textContent = savedMessage(); } });
  document.querySelector('#metadata-form input[name=timezone]').value = state.timezone || state.metadata?.timezone || browserTimeZone;
  setLanguage(selectedLanguage);
  setInterval(refresh, 1800);
})();
</script>
</body>
</html>`;
}
