/* global document */
(() => {
    const repository = 'https://github.com/amyotoff/open-pipi';
    const translations = {
        en: {
            title: 'Automatic setup.',
            lead: 'A test bench for fully automatic installation.<br>Choose a local coding agent and a real target machine.',
            experiment: 'Experimental release · results are still being tested',
            cardTitle: 'Build a precise handoff for your local agent.',
            agentNote:
                'An ordinary ChatGPT or another web chat cannot install software on your computer. Open a coding agent with local terminal access.',
            officialRepo: 'Official repository',
            clientLabel: 'Local coding agent',
            clientCodex: 'Codex — local task',
            clientClaude: 'Claude Code — terminal',
            clientAntigravity: 'Antigravity — editor agent',
            scenarioLabel: 'Target environment',
            scenarioMac: 'macOS',
            scenarioLinux: 'Linux',
            scenarioWindows: 'Windows through WSL2',
            scenarioRpi: 'Raspberry Pi 64-bit',
            scenarioVps: 'VPS through SSH',
            scenarioUpdate: 'Update an installation',
            promptLabel: 'Give this text to the selected agent',
            copy: 'Copy handoff',
            nothingInstalled: 'Copying does not install anything',
            step1Title: 'Verify the target.',
            step1Body: 'The agent checks the selected machine and looks for an existing installation.',
            step2Title: 'Install safely.',
            step2Body: 'The agent installs or updates the program while preserving your changes and data.',
            step3Title: 'Prove the result.',
            step3Body: 'Checks pass, you enter credentials privately, and a real reply is verified separately.',
            before: 'Experiment boundaries.',
            requirementsTitle: 'Which agent works?',
            requirementsBody:
                'Codex in a local task, Claude Code in a terminal, or Antigravity with project terminal access. A regular ChatGPT or Claude browser tab cannot access your machine.',
            targetsTitle: 'Which targets are supported?',
            targetsBody:
                'Native macOS and Linux; Windows only through WSL2 Linux; Raspberry Pi with 64-bit Linux and Node.js 24; VPS only through a selected SSH host.',
            updateTitle: 'How does an update work?',
            updateBody:
                'The agent locates the installation and its data, preserves your changes, and stops on conflicts.',
            privateTitle: 'Where do credentials go?',
            privateBody:
                'Only you enter them on the private local page. They must not appear in the prompt, website, or agent chat.',
            backgroundTitle: 'Will background mode start?',
            backgroundBody: 'No. It is a separate step after local verification and a separate user request.',
            installGuide: 'Installation',
            help: 'Troubleshooting',
            version: 'Build',
        },
        ru: {},
    };
    const elements = [...document.querySelectorAll('[data-i18n]')];
    elements.forEach((element) => {
        translations.ru[element.dataset.i18n] = element.innerHTML;
    });
    let language = navigator.language.toLowerCase().startsWith('ru') ? 'ru' : 'en';
    const prompt = document.getElementById('prompt');
    const skill = document.getElementById('skill-link').href;
    const fallback = document.getElementById('skill-text-link').href;
    const client = document.getElementById('client');
    const scenario = document.getElementById('scenario');
    const status = document.getElementById('copy-status');
    const switchLanguage = document.getElementById('language');
    const clientGuidance = {
        ru: {
            codex: 'Откройте Codex как локальную задачу с доступом к файлам и терминалу.',
            'claude-code': 'Запустите Claude Code в терминале нужного компьютера или сервера.',
            antigravity: 'Откройте Antigravity как агента редактора с терминалом нужного проекта.',
        },
        en: {
            codex: 'Open Codex as a local task with file and terminal access.',
            'claude-code': 'Run Claude Code in the terminal on your selected computer or server.',
            antigravity: 'Open Antigravity as an editor agent with terminal access to the intended project.',
        },
    };
    const scenarioNotes = {
        ru: {
            macos: 'Нативная macOS: сначала проверить Git, Node.js 24+ и pnpm.',
            linux: 'Нативный Linux: сначала проверить дистрибутив, архитектуру и зависимости.',
            windows: 'Windows поддерживается через WSL2 Linux, не через нативный PowerShell.',
            rpi: 'Нужен Raspberry Pi с 64-bit Linux и совместимым Node.js 24.',
            vps: 'Выберите сервер и подключение по SSH. Агент проверит адрес и папку установки.',
            update: 'Агент найдёт существующую установку, сохранит ваши изменения и данные.',
        },
        en: {
            macos: 'Native macOS: check Git, Node.js 24+, and pnpm first.',
            linux: 'Native Linux: check distribution, architecture, and dependencies first.',
            windows: 'Windows is supported through WSL2 Linux, not native PowerShell.',
            rpi: 'Requires Raspberry Pi with 64-bit Linux and compatible Node.js 24.',
            vps: 'Only an explicitly selected SSH host; confirm host and directory first.',
            update: 'The agent will locate the existing installation and preserve your changes and data.',
        },
    };
    const clientNames = { codex: 'Codex', 'claude-code': 'Claude Code', antigravity: 'Antigravity' };
    const scenarioNames = {
        ru: {
            macos: 'macOS',
            linux: 'Linux',
            windows: 'Windows через WSL2 Linux',
            rpi: 'Raspberry Pi 64-bit Linux',
            vps: 'VPS через выбранный SSH host',
            update: 'обновление существующей установки',
        },
        en: {
            macos: 'macOS',
            linux: 'Linux',
            windows: 'Windows through WSL2 Linux',
            rpi: 'Raspberry Pi 64-bit Linux',
            vps: 'a VPS through an explicitly selected SSH host',
            update: 'an existing installation update',
        },
    };
    function buildPrompt() {
        const selectedClient = clientNames[client.value];
        const target = scenarioNames[language][scenario.value];
        const update = scenario.value === 'update';
        return language === 'ru'
            ? `Ты работаешь как ${selectedClient} с локальным терминалом. Сценарий: ${target}. Официальный репозиторий: ${repository}. Инструкция: ${skill}; резервная текстовая версия: ${fallback}. Проверь реальную целевую машину, точный каталог, checkout и DATA_DIR до команд. Не устанавливай в обычном ChatGPT, другом веб-чате или cloud sandbox. ${update ? 'Это безопасное обновление: используй найденный checkout, сохрани изменения и DATA_DIR; при конфликте остановись.' : 'Это новая установка: исключи существующую, затем клонируй только официальный репозиторий в согласованный каталог без перезаписи.'} Установи, настрой и запусти Open PiPi до первого подтверждённого ответа в Telegram. Секреты ввожу только я на приватной локальной странице. Фоновый режим — отдельный шаг после моего поручения.`
            : `You are working as ${selectedClient} with local terminal access. Scenario: ${target}. Official repository: ${repository}. Instructions: ${skill}; plain-text version: ${fallback}. Verify the real target machine, exact directory, checkout, and DATA_DIR before commands. Do not install in ordinary ChatGPT, another web chat, or a cloud sandbox. ${update ? 'This is a safe update: use the existing checkout, preserve changes and DATA_DIR, and stop on conflicts.' : 'This is a fresh installation: rule out an existing installation, then clone only the official repository into the agreed directory without overwriting.'} Install, configure, and start Open PiPi through its first verified Telegram reply. I enter secrets myself on the private local page. Background mode is a separate step after my explicit request.`;
    }
    function update() {
        document.documentElement.lang = language;
        elements.forEach((element) => {
            element.innerHTML = translations[language][element.dataset.i18n];
        });
        switchLanguage.textContent = language === 'ru' ? 'EN' : 'RU';
        switchLanguage.setAttribute('aria-label', language === 'ru' ? 'Switch to English' : 'Переключить на русский');
        document.getElementById('client-guidance').textContent = clientGuidance[language][client.value];
        document.getElementById('scenario-note').textContent = scenarioNotes[language][scenario.value];
        prompt.value = buildPrompt();
        status.textContent = '';
    }
    client.addEventListener('change', update);
    scenario.addEventListener('change', update);
    switchLanguage.addEventListener('click', () => {
        language = language === 'ru' ? 'en' : 'ru';
        update();
    });
    document.getElementById('copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(prompt.value);
            status.textContent =
                language === 'ru'
                    ? 'Скопировано. Передайте поручение локальному агенту.'
                    : 'Copied. Give the handoff to your local agent.';
        } catch {
            prompt.focus();
            prompt.select();
            status.textContent =
                language === 'ru' ? 'Текст выделен — скопируйте вручную.' : 'Text selected — copy it manually.';
        }
    });
    update();
})();
