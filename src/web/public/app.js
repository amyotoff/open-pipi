/**
 * The whole web client. No framework, no build step — this file is what runs.
 *
 * Live updates come from one server event: "this space moved". The client's
 * whole reaction is to refetch that space. That means a dropped connection
 * costs nothing to recover from — no cursor, no replay, no gap to reconcile.
 */

const el = (id) => document.getElementById(id);

const state = {
    spaces: [],
    activeSpaceId: null,
    events: null,
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

function parseEventData(data) {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function setConnectionNotice(text) {
    el('connection').textContent = text;
}

/**
 * Listen for activity. Membership is enforced server-side, so this stream only
 * ever mentions spaces the signed-in person belongs to.
 */
function connectEvents() {
    if (state.events) return;

    const events = new EventSource('/api/events');
    state.events = events;

    events.addEventListener('open', () => {
        setConnectionNotice('');
        // A reconnect may have missed events, so re-read what is on screen.
        if (state.activeSpaceId) void openSpace(state.activeSpaceId);
    });

    events.addEventListener('space_activity', (event) => {
        const payload = parseEventData(event.data);
        if (!payload) return;

        void refreshSpaceList();
        if (payload.space_id === state.activeSpaceId) {
            void openSpace(state.activeSpaceId);
        }
    });

    events.addEventListener('error', () => {
        // EventSource retries on its own; this only explains the pause.
        setConnectionNotice('Reconnecting…');
    });
}

function disconnectEvents() {
    state.events?.close();
    state.events = null;
}

async function openSpace(spaceId) {
    state.activeSpaceId = spaceId;
    renderSpaces();
    el('composer').hidden = false;

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

async function refreshSpaceList() {
    const { ok, body } = await api('/api/spaces');
    if (!ok || !body?.ok) return;
    state.spaces = body.spaces;
    renderSpaces();
}

async function loadWorkspace(me) {
    el('who').textContent = me.participant.display_name || me.username;

    await refreshSpaceList();
    connectEvents();

    if (state.spaces.length > 0) {
        await openSpace(state.spaces[0].id);
    } else {
        el('composer').hidden = true;
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

el('composer').addEventListener('submit', async (event) => {
    event.preventDefault();
    const field = el('composer-text');
    const text = field.value.trim();
    if (!text || !state.activeSpaceId) return;

    field.value = '';
    const { ok } = await api(`/api/spaces/${encodeURIComponent(state.activeSpaceId)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ text }),
    });

    if (!ok) {
        // Give the text back rather than losing what someone typed.
        field.value = text;
        setConnectionNotice('Could not send that. Try again.');
        return;
    }

    setConnectionNotice('');
    await openSpace(state.activeSpaceId);
});

el('logout').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    disconnectEvents();
    state.spaces = [];
    state.activeSpaceId = null;
    el('composer').hidden = true;
    show('login');
});

if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        void navigator.serviceWorker.register('/sw.js').catch(() => {
            // An unregistered worker only costs offline shell caching.
        });
    });
}

void start();
