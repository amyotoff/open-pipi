const DEFAULT_BASE_URL = 'http://127.0.0.1:8123';
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_ENTITY_RESULTS = 50;
const ENTITY_ID_PATTERN = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;

export const HOME_ASSISTANT_ACTIONS = ['turn_on', 'turn_off', 'set_brightness'] as const;
export type HomeAssistantAction = (typeof HOME_ASSISTANT_ACTIONS)[number];

export interface HomeAssistantConfig {
    baseUrl: string;
    token: string;
    readEntities: ReadonlySet<string>;
    controlEntities: ReadonlySet<string>;
    timeoutMs: number;
}

export interface HomeAssistantState {
    entity_id: string;
    domain: string;
    state: string;
    last_changed?: string;
    last_updated?: string;
    attributes: Record<string, string | number | boolean | Array<string | number | boolean>>;
    allowed_actions: HomeAssistantAction[];
}

interface HomeAssistantControlPlan {
    entityId: string;
    action: HomeAssistantAction;
    value?: number;
    domain: string;
    service: 'turn_on' | 'turn_off';
    body: Record<string, string | number>;
}

export class HomeAssistantError extends Error {
    constructor(
        message: string,
        readonly code: string
    ) {
        super(message);
        this.name = 'HomeAssistantError';
    }
}

function parseEntityList(value: string | undefined): ReadonlySet<string> {
    return new Set(
        (value || '')
            .split(',')
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean)
    );
}

function normalizeBaseUrl(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new HomeAssistantError('HOME_ASSISTANT_URL must be a valid absolute URL.', 'invalid_url');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new HomeAssistantError('HOME_ASSISTANT_URL must use http or https.', 'invalid_url');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new HomeAssistantError(
            'HOME_ASSISTANT_URL must not contain credentials, a query, or a fragment.',
            'invalid_url'
        );
    }
    if (parsed.pathname && parsed.pathname !== '/') {
        throw new HomeAssistantError('HOME_ASSISTANT_URL must point to the server root.', 'invalid_url');
    }

    return parsed.origin;
}

function parseTimeout(value: string | undefined): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 500) return DEFAULT_TIMEOUT_MS;
    return Math.min(Math.floor(parsed), MAX_TIMEOUT_MS);
}

export function readHomeAssistantConfig(env: Record<string, string | undefined> = process.env): HomeAssistantConfig {
    return {
        baseUrl: normalizeBaseUrl((env.HOME_ASSISTANT_URL || DEFAULT_BASE_URL).trim()),
        token: (env.HOME_ASSISTANT_TOKEN || '').trim(),
        readEntities: parseEntityList(env.HOME_ASSISTANT_READ_ENTITIES),
        controlEntities: parseEntityList(env.HOME_ASSISTANT_CONTROL_ENTITIES),
        timeoutMs: parseTimeout(env.HOME_ASSISTANT_TIMEOUT_MS),
    };
}

function assertEntityId(entityId: string): string {
    const normalized = entityId.trim().toLowerCase();
    if (!ENTITY_ID_PATTERN.test(normalized)) {
        throw new HomeAssistantError('entity_id must look like "light.kitchen".', 'invalid_entity_id');
    }
    return normalized;
}

function domainOf(entityId: string): string {
    return entityId.slice(0, entityId.indexOf('.'));
}

function allowedActionsForDomain(domain: string): HomeAssistantAction[] {
    if (domain === 'light') return ['turn_on', 'turn_off', 'set_brightness'];
    if (domain === 'switch') return ['turn_on', 'turn_off'];
    return [];
}

const SAFE_ATTRIBUTE_KEYS = new Set([
    'friendly_name',
    'device_class',
    'unit_of_measurement',
    'brightness',
    'color_temp_kelvin',
    'rgb_color',
    'current_temperature',
    'temperature',
    'humidity',
    'percentage',
]);

function sanitizeScalar(value: unknown): string | number | boolean | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return sanitizeText(value, 160);
    return null;
}

function sanitizeText(value: string, maxLength: number): string {
    return [...value]
        .map((character) => {
            const code = character.charCodeAt(0);
            return code < 32 || code === 127 ? ' ' : character;
        })
        .join('')
        .trim()
        .slice(0, maxLength);
}

function sanitizeAttributes(value: unknown): HomeAssistantState['attributes'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    const attributes: HomeAssistantState['attributes'] = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
        if (!SAFE_ATTRIBUTE_KEYS.has(key)) continue;

        if (Array.isArray(raw)) {
            const items = raw
                .slice(0, 8)
                .map(sanitizeScalar)
                .filter((item): item is string | number | boolean => item !== null);
            if (items.length > 0) attributes[key] = items;
            continue;
        }

        const scalar = sanitizeScalar(raw);
        if (scalar !== null) attributes[key] = scalar;
    }
    return attributes;
}

async function readLimitedText(response: Response): Promise<string> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
        throw new HomeAssistantError('Home Assistant response exceeded the safe size limit.', 'response_too_large');
    }

    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new HomeAssistantError('Home Assistant response exceeded the safe size limit.', 'response_too_large');
        }
        chunks.push(value);
    }

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
}

function sanitizeState(raw: unknown, controlEntities: ReadonlySet<string>): HomeAssistantState {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new HomeAssistantError('Home Assistant returned an invalid state object.', 'invalid_response');
    }

    const record = raw as Record<string, unknown>;
    const entityId = typeof record.entity_id === 'string' ? assertEntityId(record.entity_id) : '';
    if (!entityId || typeof record.state !== 'string') {
        throw new HomeAssistantError('Home Assistant returned an incomplete state object.', 'invalid_response');
    }
    const domain = domainOf(entityId);

    return {
        entity_id: entityId,
        domain,
        state: sanitizeText(record.state, 160),
        last_changed: typeof record.last_changed === 'string' ? record.last_changed.slice(0, 64) : undefined,
        last_updated: typeof record.last_updated === 'string' ? record.last_updated.slice(0, 64) : undefined,
        attributes: sanitizeAttributes(record.attributes),
        allowed_actions: controlEntities.has(entityId) ? allowedActionsForDomain(domain) : [],
    };
}

function isKnownControlRejection(error: unknown): boolean {
    return (
        error instanceof HomeAssistantError &&
        ['http_400', 'http_401', 'http_403', 'http_404', 'http_405', 'http_422'].includes(error.code)
    );
}

export class HomeAssistantClient {
    private readonly fetchImpl: typeof fetch;

    constructor(
        private readonly config: HomeAssistantConfig,
        fetchImpl: typeof fetch = globalThis.fetch
    ) {
        this.fetchImpl = fetchImpl;
    }

    private assertConfigured(): void {
        if (!this.config.token) {
            throw new HomeAssistantError(
                'Home Assistant is not configured. Set HOME_ASSISTANT_TOKEN privately on the Open PiPi host.',
                'not_configured'
            );
        }
    }

    private canRead(entityId: string): boolean {
        return this.config.readEntities.has(entityId) || this.config.controlEntities.has(entityId);
    }

    private assertReadable(entityId: string): string {
        const normalized = assertEntityId(entityId);
        if (!this.canRead(normalized)) {
            throw new HomeAssistantError(
                `Entity "${normalized}" is not in the Home Assistant read allowlist.`,
                'entity_not_allowed'
            );
        }
        return normalized;
    }

    private async request(pathname: string, init: RequestInit = {}): Promise<unknown> {
        this.assertConfigured();
        const url = new URL(pathname.replace(/^\/+/, ''), `${this.config.baseUrl}/`);
        if (url.origin !== this.config.baseUrl) {
            throw new HomeAssistantError(
                'Refusing a Home Assistant request outside the configured origin.',
                'unsafe_url'
            );
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
            const response = await this.fetchImpl(url, {
                ...init,
                redirect: 'manual',
                signal: controller.signal,
                headers: {
                    Authorization: `Bearer ${this.config.token}`,
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    ...(init.headers || {}),
                },
            });

            if (response.status >= 300 && response.status < 400) {
                throw new HomeAssistantError('Home Assistant redirects are not accepted.', 'redirect_rejected');
            }

            const text = await readLimitedText(response);
            if (!response.ok) {
                const message =
                    response.status === 401
                        ? 'Home Assistant rejected the configured token.'
                        : response.status === 403
                          ? 'The Home Assistant user is not permitted to perform this action.'
                          : response.status === 404
                            ? 'Home Assistant could not find the requested entity or API endpoint.'
                            : `Home Assistant returned HTTP ${response.status}.`;
                throw new HomeAssistantError(message, `http_${response.status}`);
            }

            if (!text.trim()) return null;
            try {
                return JSON.parse(text);
            } catch {
                throw new HomeAssistantError('Home Assistant returned non-JSON data.', 'invalid_response');
            }
        } catch (error) {
            if (error instanceof HomeAssistantError) throw error;
            const timedOut = controller.signal.aborted;
            throw new HomeAssistantError(
                timedOut
                    ? 'Home Assistant did not respond before the local timeout.'
                    : 'Home Assistant could not be reached on the configured local URL.',
                timedOut ? 'timeout' : 'network_error'
            );
        } finally {
            clearTimeout(timeout);
        }
    }

    async status(): Promise<{ connected: true; version?: string; time_zone?: string }> {
        const config = (await this.request('/api/config')) as Record<string, unknown>;
        return {
            connected: true,
            version: typeof config?.version === 'string' ? config.version.slice(0, 64) : undefined,
            time_zone: typeof config?.time_zone === 'string' ? config.time_zone.slice(0, 64) : undefined,
        };
    }

    async getState(entityId: string): Promise<HomeAssistantState> {
        const allowedId = this.assertReadable(entityId);
        const state = await this.request(`/api/states/${encodeURIComponent(allowedId)}`);
        return sanitizeState(state, this.config.controlEntities);
    }

    async listEntities(options: { domain?: string; query?: string } = {}): Promise<{
        entities: HomeAssistantState[];
        unavailable: string[];
    }> {
        this.assertConfigured();
        const domain = (options.domain || '').trim().toLowerCase();
        const query = (options.query || '').trim().toLowerCase();
        if (domain && !/^[a-z][a-z0-9_]*$/.test(domain)) {
            throw new HomeAssistantError(
                'domain must contain lowercase letters, digits, or underscores.',
                'invalid_domain'
            );
        }

        const allowedIds = [...new Set([...this.config.readEntities, ...this.config.controlEntities])]
            .filter((entityId) => !domain || domainOf(entityId) === domain)
            .slice(0, MAX_ENTITY_RESULTS);

        const settled = await Promise.allSettled(allowedIds.map((entityId) => this.getState(entityId)));
        const fatalFailure = settled.find(
            (result) =>
                result.status === 'rejected' &&
                (!(result.reason instanceof HomeAssistantError) || result.reason.code !== 'http_404')
        );
        if (fatalFailure?.status === 'rejected') throw fatalFailure.reason;

        const entities: HomeAssistantState[] = [];
        const unavailable: string[] = [];
        settled.forEach((result, index) => {
            if (result.status === 'fulfilled') {
                const friendlyName = result.value.attributes.friendly_name;
                const matchesQuery =
                    !query ||
                    result.value.entity_id.includes(query) ||
                    (typeof friendlyName === 'string' && friendlyName.toLowerCase().includes(query));
                if (matchesQuery) entities.push(result.value);
            } else if (!query || allowedIds[index].includes(query)) {
                unavailable.push(allowedIds[index]);
            }
        });
        return { entities, unavailable };
    }

    planControl(entityId: string, action: HomeAssistantAction, value?: number): HomeAssistantControlPlan {
        this.assertConfigured();
        const normalized = assertEntityId(entityId);
        if (!this.config.controlEntities.has(normalized)) {
            throw new HomeAssistantError(
                `Entity "${normalized}" is not in the Home Assistant control allowlist.`,
                'entity_not_allowed'
            );
        }

        const domain = domainOf(normalized);
        const allowedActions = allowedActionsForDomain(domain);
        if (!allowedActions.includes(action)) {
            throw new HomeAssistantError(
                `Action "${action}" is not allowed for Home Assistant domain "${domain}".`,
                'action_not_allowed'
            );
        }

        if (action === 'set_brightness') {
            if (domain !== 'light' || !Number.isInteger(value) || value! < 0 || value! > 100) {
                throw new HomeAssistantError(
                    'set_brightness requires an integer value from 0 to 100.',
                    'invalid_value'
                );
            }
            return {
                entityId: normalized,
                action,
                value,
                domain,
                service: 'turn_on',
                body: { entity_id: normalized, brightness_pct: value! },
            };
        }

        if (value !== undefined) {
            throw new HomeAssistantError(`Action "${action}" does not accept a value.`, 'invalid_value');
        }

        return {
            entityId: normalized,
            action,
            domain,
            service: action,
            body: { entity_id: normalized },
        };
    }

    async control(
        entityId: string,
        action: HomeAssistantAction,
        value?: number
    ): Promise<{
        accepted: true;
        verified: boolean;
        state?: HomeAssistantState;
        verification_error?: string;
    }> {
        const plan = this.planControl(entityId, action, value);
        try {
            await this.request(`/api/services/${plan.domain}/${plan.service}`, {
                method: 'POST',
                body: JSON.stringify(plan.body),
            });
        } catch (error) {
            if (isKnownControlRejection(error)) throw error;
            throw new HomeAssistantError(
                'The Home Assistant control outcome is unknown. Read the entity state before considering a retry.',
                'unknown_control_outcome'
            );
        }

        try {
            const state = await this.getState(plan.entityId);
            const expectedState = plan.action === 'turn_off' ? 'off' : 'on';
            const stateMatches = state.state === expectedState;
            const brightness = state.attributes.brightness;
            const brightnessPercent =
                typeof brightness === 'number'
                    ? Math.round((Math.max(0, Math.min(255, brightness)) / 255) * 100)
                    : null;
            const brightnessMatches =
                plan.action !== 'set_brightness' ||
                (brightnessPercent !== null && Math.abs(brightnessPercent - (plan.value || 0)) <= 2);
            return { accepted: true, verified: stateMatches && brightnessMatches, state };
        } catch {
            return {
                accepted: true,
                verified: false,
                verification_error: 'The service was accepted, but the final state could not be read.',
            };
        }
    }
}

export function createHomeAssistantClient(
    env: Record<string, string | undefined> = process.env,
    fetchImpl: typeof fetch = globalThis.fetch
): HomeAssistantClient {
    return new HomeAssistantClient(readHomeAssistantConfig(env), fetchImpl);
}
