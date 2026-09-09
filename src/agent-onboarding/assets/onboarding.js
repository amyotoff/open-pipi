/* global document */
(() => {
    const translations = {
        en: {
            title: 'Hello, PiPi.',
            lead: 'Your personal assistant in Telegram.<br>One link for your agent. A conversation for you.',
            experiment: 'First test release',
            cardTitle: 'Let your agent handle setup.',
            agentNote: 'Codex, Claude Code, or another agent with terminal access.',
            newInstall: 'New PiPi',
            existingInstall: 'Already installed',
            promptLabel: 'Send this message to your agent',
            copy: 'Copy instructions',
            nothingInstalled: 'Copying does not install anything',
            step1Title: 'Your agent prepares.',
            step1Body: 'Checks your computer, installs PiPi, and opens the private setup page.',
            step2Title: 'You connect.',
            step2Body: 'Connect AI, create a Telegram bot, and link your account on the local page.',
            step3Title: 'PiPi replies.',
            step3Body:
                'Select “Try now” and message your bot. Your agent verifies that a reply was actually delivered.',
            before: 'Before your first conversation.',
            requirementsTitle: 'What do I need?',
            requirementsBody:
                'A computer with Git, Node.js 24+ and pnpm 10.26.2, a coding agent with a terminal, Telegram, and access to an AI provider. If something is missing, your agent explains the next step.',
            whereTitle: 'Where does PiPi run?',
            whereBody:
                'On your computer. This Cloudflare website serves public instructions. PiPi works while your computer is awake and on; permanent hosting can be arranged later.',
            costTitle: 'What about model costs?',
            costBody:
                'Setup uses OpenRouter by default. Model usage is billed separately from ChatGPT and Claude subscriptions.',
            privateTitle: 'Where do I enter keys?',
            privateBody:
                'Only on the private setup page that opens on your computer. Do not send them to your coding agent or this website.',
            doneTitle: 'When is setup complete?',
            doneBody:
                'When the running PiPi has delivered a reply to your Telegram message. Installed files or saved settings alone do not prove a working conversation.',
            installGuide: 'Installation',
            help: 'Troubleshooting',
            version: 'Release',
        },
        ru: {},
    };
    const elements = [...document.querySelectorAll('[data-i18n]')];
    elements.forEach((element) => {
        translations.ru[element.dataset.i18n] = element.innerHTML;
    });
    let language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
    let existing = false;
    const prompt = document.getElementById('prompt');
    const skill = document.getElementById('skill-link').href;
    const status = document.getElementById('copy-status');
    const switchLanguage = document.getElementById('language');
    function update() {
        document.documentElement.lang = language;
        elements.forEach((element) => {
            element.innerHTML = translations[language][element.dataset.i18n];
        });
        switchLanguage.textContent = language === 'ru' ? 'EN' : 'RU';
        switchLanguage.setAttribute('aria-label', language === 'ru' ? 'Switch to English' : 'Переключить на русский');
        const intent = existing
            ? language === 'ru'
                ? 'помоги продолжить настройку существующего Open PiPi на этом компьютере до первого подтверждённого ответа в Telegram. Сначала найди и проверь мою установку; сохрани её настройки и изменения.'
                : 'help me finish setting up my existing Open PiPi on this computer until its first verified Telegram reply. Locate and inspect my installation first; preserve its settings and changes.'
            : language === 'ru'
              ? 'помоги установить, настроить и запустить Open PiPi на этом компьютере до первого подтверждённого ответа в Telegram. Сначала проверь, нет ли существующей установки.'
              : 'help me install, configure, and start Open PiPi on this computer until its first verified Telegram reply. Check for an existing installation first.';
        prompt.value =
            language === 'ru'
                ? `Прочитай ${skill} и ${intent} Подключения и секреты я введу сам в приватной странице настройки. Фоновый режим выберу отдельно.`
                : `Read ${skill} and ${intent} I will connect accounts and enter secrets myself in the private setup page. I will choose background mode separately.`;
        document.getElementById('new-install').setAttribute('aria-pressed', String(!existing));
        document.getElementById('existing-install').setAttribute('aria-pressed', String(existing));
        status.textContent = '';
    }
    document.getElementById('new-install').addEventListener('click', () => {
        existing = false;
        update();
    });
    document.getElementById('existing-install').addEventListener('click', () => {
        existing = true;
        update();
    });
    switchLanguage.addEventListener('click', () => {
        language = language === 'ru' ? 'en' : 'ru';
        update();
    });
    document.getElementById('copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(prompt.value);
            status.textContent =
                language === 'ru'
                    ? 'Скопировано. Отправьте инструкцию своему агенту.'
                    : 'Copied. Send the instructions to your agent.';
        } catch {
            prompt.focus();
            prompt.select();
            status.textContent =
                language === 'ru' ? 'Текст выделен — скопируйте его вручную.' : 'Text selected — copy it manually.';
        }
    });
    update();
})();
