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
    view: 'chat',
    isOwner: false,
};

/**
 * Every dashboard view: a title, one line saying what it is for, and how to
 * turn its data into rows. Adding a view means adding an entry, not a branch.
 */
const ADMIN_VIEWS = {
    overview: { title: 'Overview', subtitle: 'Health, delivery, and how the runtime is wired.', path: '/api/admin/overview' },
    spaces: { title: 'Spaces', subtitle: 'Every space, and what decides how it behaves.', path: '/api/admin/spaces' },
    delivery: { title: 'Delivery', subtitle: 'Messages still queued, retrying, or given up on.', path: '/api/admin/delivery' },
    brain: { title: 'Wiki', subtitle: 'Curated pages and notebook notes the assistant keeps.', path: '/api/admin/brain' },
    memory: { title: 'Memory', subtitle: 'What the assistant remembers, newest first.', path: '/api/admin/memory' },
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

// ==========================================
// Small builders — text only, never innerHTML
// ==========================================

function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
}

function stat(label, value, tone) {
    const box = node('div', 'stat');
    box.append(node('span', 'stat-label', label));
    box.append(node('span', `stat-value${tone ? ` is-${tone}` : ''}`, value));
    return box;
}

function pill(text, tone) {
    return node('span', `pill${tone ? ` is-${tone}` : ''}`, text);
}

/** A card with a table inside, or a plain line when there is nothing to show. */
function table(title, columns, rows) {
    const card = node('section', 'card');
    card.append(node('h3', null, title));

    if (rows.length === 0) {
        card.append(node('p', 'empty', 'Nothing here.'));
        return card;
    }

    const scroll = node('div', 'table-scroll');
    const element = document.createElement('table');
    const head = document.createElement('tr');
    for (const column of columns) head.append(node('th', null, column));
    element.append(head);

    for (const row of rows) {
        const tr = document.createElement('tr');
        for (const cell of row) {
            const td = node('td', 'wrap');
            td.append(cell instanceof Node ? cell : document.createTextNode(String(cell ?? '')));
            tr.append(td);
        }
        element.append(tr);
    }

    scroll.append(element);
    card.append(scroll);
    return card;
}

function shortTime(value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? '' : new Date(parsed).toLocaleString();
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

    // The dashboard is only offered to an owner; the API refuses everyone else
    // regardless, and answers 404 so its existence stays quiet.
    state.isOwner = me.participant.role === 'owner';
    el('admin-nav').hidden = !state.isOwner;

    await refreshSpaceList();
    connectEvents();

    if (state.spaces.length > 0) {
        await openSpace(state.spaces[0].id);
    } else {
        el('composer').hidden = true;
        renderMessages(null, []);
    }
}

// ==========================================
// Dashboard views
// ==========================================

function renderOverview(body, data) {
    const health = data.health || {};
    const stats = node('div', 'stats');
    for (const [label, key] of [
        ['Gemini', 'gemini'],
        ['Ollama', 'ollama'],
        ['Internet', 'internet'],
        ['Disk', 'disk_ok'],
        ['Memory', 'ram_ok'],
    ]) {
        stats.append(stat(label, health[key] ? 'ok' : 'down', health[key] ? 'ok' : 'bad'));
    }
    body.append(stats);

    const outbox = data.outbox || {};
    const queue = node('div', 'stats');
    queue.append(stat('Queued', outbox.queued || 0));
    queue.append(stat('Sent', outbox.sent || 0));
    queue.append(stat('Failed', outbox.failed || 0, outbox.failed ? 'bad' : undefined));
    queue.append(stat('Web clients', data.web_subscribers || 0));
    body.append(queue);

    const topology = data.topology || {};
    body.append(
        table(
            'Wiring',
            ['What', 'Count'],
            [
                ['Spaces', topology.spaces],
                ['Bindings', topology.bindings],
                ['Participants', topology.participants],
                ['Identities', topology.identities],
                ['Transports running', (data.transports || []).join(', ') || 'none'],
            ]
        )
    );

    // Only worth showing when something actually needs a human.
    const orphans = [
        ...(topology.spaces_without_binding || []).map((id) => ['Space without a binding', id]),
        ...(topology.participants_without_identity || []).map((id) => ['Participant without an identity', id]),
    ];
    if (orphans.length > 0) body.append(table('Needs a look', ['Problem', 'Which'], orphans));
}

function renderSpacesView(body, data) {
    body.append(
        table(
            'Spaces',
            ['Space', 'Pack', 'Grounding', 'Mode', 'Reachable from'],
            (data.spaces || []).map((space) => {
                const bindings = node('span');
                for (const binding of space.bindings) {
                    bindings.append(pill(binding.transport, binding.status === 'active' ? undefined : 'bad'));
                    bindings.append(document.createTextNode(' '));
                }
                if (space.bindings.length === 0) bindings.append(pill('none', 'bad'));

                return [space.title, space.pack, space.grounding, space.channel_mode, bindings];
            })
        )
    );
}

function renderDelivery(body, data) {
    const counts = data.counts || {};
    const stats = node('div', 'stats');
    stats.append(stat('Queued', counts.queued || 0));
    stats.append(stat('Failed', counts.failed || 0, counts.failed ? 'bad' : undefined));
    stats.append(stat('Sent', counts.sent || 0, 'ok'));
    body.append(stats);

    body.append(
        table(
            'Not delivered yet',
            ['Status', 'Transport', 'Endpoint', 'Tries', 'Last error'],
            (data.entries || []).map((entry) => [
                pill(entry.status, entry.status === 'failed' ? 'bad' : undefined),
                entry.transport,
                entry.endpoint_id,
                entry.attempts,
                entry.last_error || '',
            ])
        )
    );
}

async function renderBrain(body, data) {
    const pages = data.wiki_pages || [];
    body.append(
        table(
            'Wiki pages',
            ['Page', 'Title', 'Updated'],
            pages.map((page) => {
                const link = node('button', 'link', page.path);
                link.type = 'button';
                link.addEventListener('click', () => void openWikiPage(page.path));
                return [link, page.title, shortTime(page.updated_at)];
            })
        )
    );

    body.append(
        table(
            'Notebook notes',
            ['Topic', 'Note', 'Status'],
            (data.notes || []).map((note) => [note.topic, note.text, pill(note.status)])
        )
    );
}

async function openWikiPage(pagePath) {
    const { ok, body } = await api(`/api/admin/brain/page?path=${encodeURIComponent(pagePath)}`);
    if (!ok || !body?.ok) return;

    const card = node('section', 'card');
    card.append(node('h3', null, pagePath));
    // textContent, so a wiki page is read as text and never as markup.
    card.append(node('pre', 'page-body', body.page.content || '(empty)'));
    el('admin-body').prepend(card);
}

function renderMemory(body, data) {
    body.append(
        table(
            'Memory',
            ['Scope', 'Kind', 'Content', 'Updated'],
            (data.entries || []).map((entry) => [
                `${entry.scope_type}:${entry.scope_id}`,
                entry.kind,
                entry.content,
                shortTime(entry.updated_at),
            ])
        )
    );
}

const RENDERERS = {
    overview: renderOverview,
    spaces: renderSpacesView,
    delivery: renderDelivery,
    brain: renderBrain,
    memory: renderMemory,
};

async function openAdminView(view) {
    const config = ADMIN_VIEWS[view];
    if (!config) return;

    el('admin-title').textContent = config.title;
    el('admin-subtitle').textContent = config.subtitle;

    const body = el('admin-body');
    body.replaceChildren(node('p', 'empty', 'Loading…'));

    const { ok, body: payload } = await api(config.path);
    body.replaceChildren();

    if (!ok || !payload?.ok) {
        body.append(node('p', 'empty', 'Could not load that right now.'));
        return;
    }

    await RENDERERS[view](body, payload);
}

function setView(view) {
    state.view = view;
    for (const item of document.querySelectorAll('.nav-item')) {
        item.setAttribute('aria-current', String(item.dataset.view === view));
    }

    const isChat = view === 'chat';
    el('view-chat').hidden = !isChat;
    el('view-admin').hidden = isChat;
    el('space-list-panel').hidden = !isChat;

    if (!isChat) void openAdminView(view);
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

for (const item of document.querySelectorAll('.nav-item')) {
    item.addEventListener('click', () => setView(item.dataset.view));
}

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
    state.isOwner = false;
    el('composer').hidden = true;
    el('admin-nav').hidden = true;
    setView('chat');
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
