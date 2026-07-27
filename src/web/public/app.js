/**
 * The whole web client. No framework, no build step — this file is what runs.
 *
 * Read-only for now: it signs in, lists the spaces you belong to, and shows
 * their history. Sending arrives with the next release.
 */

const el = (id) => document.getElementById(id);

const state = {
    spaces: [],
    activeSpaceId: null,
};

async function api(path, options = {}) {
    const response = await fetch(path, {
        credentials: 'same-origin',
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...(options.headers || {}),
        },
    });

    let body = null;
    try {
        body = await response.json();
    } catch {
        // A non-JSON response means something upstream broke; the status still
        // tells us what to do.
    }

    return { ok: response.ok, status: response.status, body };
}

function show(section) {
    el('login').hidden = section !== 'login';
    el('workspace').hidden = section !== 'workspace';
}

function formatTime(timestamp) {
    const parsed = Date.parse(timestamp);
    if (Number.isNaN(parsed)) return '';
    return new Date(parsed).toLocaleString();
}

function renderSpaces() {
    const list = el('spaces');
    list.replaceChildren();

    for (const space of state.spaces) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('aria-current', String(space.id === state.activeSpaceId));

        const title = document.createElement('span');
        title.className = 'space-title';
        title.textContent = space.title;

        const preview = document.createElement('span');
        preview.className = 'space-preview';
        preview.textContent = space.last_message_preview || 'No messages yet';

        button.append(title, preview);
        button.addEventListener('click', () => void openSpace(space.id));
        item.append(button);
        list.append(item);
    }
}

function renderMessages(space, messages) {
    el('space-title').textContent = space ? space.title : 'Pick a space';

    const list = el('messages');
    list.replaceChildren();

    for (const message of messages) {
        const item = document.createElement('li');
        item.className = message.is_bot ? 'message from-assistant' : 'message';

        const meta = document.createElement('span');
        meta.className = 'message-meta';
        meta.textContent = `${message.is_bot ? 'Assistant' : message.sender_id || 'Someone'} · ${formatTime(message.timestamp)}`;

        // textContent throughout: message bodies are other people's words and
        // must never be parsed as markup.
        const body = document.createElement('span');
        body.textContent = message.content;

        item.append(meta, body);
        list.append(item);
    }

    list.scrollTop = list.scrollHeight;
}

async function openSpace(spaceId) {
    state.activeSpaceId = spaceId;
    renderSpaces();

    const { ok, body } = await api(`/api/spaces/${encodeURIComponent(spaceId)}/messages`);
    if (!ok || !body?.ok) {
        renderMessages(null, []);
        return;
    }

    renderMessages(
        state.spaces.find((space) => space.id === spaceId),
        body.messages
    );
}

async function loadWorkspace(me) {
    el('who').textContent = me.participant.display_name || me.username;

    const { ok, body } = await api('/api/spaces');
    state.spaces = ok && body?.ok ? body.spaces : [];
    renderSpaces();

    if (state.spaces.length > 0) {
        await openSpace(state.spaces[0].id);
    } else {
        renderMessages(null, []);
    }
}

async function start() {
    const { ok, body } = await api('/api/me');
    if (ok && body?.ok) {
        show('workspace');
        await loadWorkspace(body);
        return;
    }
    show('login');
}

el('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const error = el('login-error');
    error.hidden = true;

    const { ok, body } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username: el('username').value, password: el('password').value }),
    });

    if (!ok) {
        error.textContent = body?.error || 'Sign-in failed.';
        error.hidden = false;
        return;
    }

    el('password').value = '';
    await start();
});

el('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    state.spaces = [];
    state.activeSpaceId = null;
    show('login');
});

void start();
