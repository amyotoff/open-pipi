import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export type DoctorCheck = {
    id: string;
    label: string;
    status: DoctorStatus;
    message: string;
};

export type DoctorInput = {
    cwd: string;
    nodeVersion: string;
    envFileFound: boolean;
    envFileError?: boolean;
    env: Record<string, string | undefined>;
};

export type DoctorIO = {
    exists: (targetPath: string) => boolean;
    isDirectory: (targetPath: string) => boolean;
    isWritable: (targetPath: string) => boolean;
    canResolvePackage: (packageName: string, cwd: string) => boolean;
};

const MIN_NODE_MAJOR = 24;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

const defaultIO: DoctorIO = {
    exists: (targetPath) => fs.existsSync(targetPath),
    isDirectory: (targetPath) => {
        try {
            return fs.statSync(targetPath).isDirectory();
        } catch {
            return false;
        }
    },
    isWritable: (targetPath) => {
        try {
            fs.accessSync(targetPath, fs.constants.W_OK);
            return true;
        } catch {
            return false;
        }
    },
    canResolvePackage: (packageName, cwd) => {
        try {
            require.resolve(packageName, { paths: [cwd] });
            return true;
        } catch {
            return false;
        }
    },
};

function check(id: string, label: string, status: DoctorStatus, message: string): DoctorCheck {
    return { id, label, status, message };
}

function hasConfiguredValue(value: string | undefined): boolean {
    const normalized = (value || '').trim();
    if (!normalized) return false;

    const lower = normalized.toLowerCase();
    return !(
        ['...', 'changeme', 'change-me', 'example', 'xxx'].includes(lower) ||
        /^<.*>$/.test(normalized) ||
        /^your[_ -]/i.test(normalized)
    );
}

function isEnabled(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes((value || '').trim().toLowerCase());
}

function isValidTimeZone(value: string): boolean {
    try {
        new Intl.DateTimeFormat('en', { timeZone: value }).format();
        return true;
    } catch {
        return false;
    }
}

function findExistingAncestor(targetPath: string, io: DoctorIO): string | null {
    let current = path.resolve(targetPath);

    while (!io.exists(current)) {
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }

    return current;
}

function inspectNamedAsset(kind: 'pack' | 'grounding', id: string, cwd: string, io: DoctorIO): DoctorCheck {
    const label = kind === 'pack' ? 'Default pack' : 'Default grounding';
    if (!SAFE_ID_PATTERN.test(id)) {
        return check(kind, label, 'fail', `${id} is not a safe ${kind} ID.`);
    }

    const fileName = kind === 'pack' ? 'agent.md' : 'grounding.md';
    const directory = kind === 'pack' ? 'packs' : 'groundings';
    const targetPath = path.join(cwd, 'src', directory, id, fileName);
    return io.exists(targetPath)
        ? check(kind, label, 'pass', `${id} is available.`)
        : check(kind, label, 'fail', `${id} was not found at src/${directory}/${id}/${fileName}.`);
}

function inspectOptionalChannel(
    id: string,
    label: string,
    configuredValues: Array<string | undefined>,
    packages: string[],
    cwd: string,
    io: DoctorIO
): DoctorCheck | null {
    const configuredCount = configuredValues.filter(hasConfiguredValue).length;
    if (configuredCount === 0) return null;
    if (configuredCount !== configuredValues.length) {
        return check(
            id,
            label,
            'fail',
            `${label} is partially configured; fill every required value or clear them all.`
        );
    }

    const missing = packages.filter((packageName) => !io.canResolvePackage(packageName, cwd));
    return missing.length === 0
        ? check(id, label, 'pass', `${label} configuration and optional dependencies are available.`)
        : check(
              id,
              label,
              'fail',
              `${label} is enabled but missing packages: ${missing.join(', ')}. Run pnpm install.`
          );
}

export function inspectDoctor(input: DoctorInput, io: DoctorIO = defaultIO): DoctorCheck[] {
    const checks: DoctorCheck[] = [];
    const nodeMajor = Number(input.nodeVersion.split('.')[0]);
    checks.push(
        Number.isInteger(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR
            ? check('node', 'Node.js', 'pass', `${input.nodeVersion} satisfies >=${MIN_NODE_MAJOR}.`)
            : check(
                  'node',
                  'Node.js',
                  'fail',
                  `${input.nodeVersion} is unsupported; install Node.js ${MIN_NODE_MAJOR}+.`
              )
    );

    checks.push(
        input.envFileError
            ? check('env-file', '.env file', 'fail', '.env exists but could not be read.')
            : input.envFileFound
              ? check('env-file', '.env file', 'pass', '.env was found.')
              : check(
                    'env-file',
                    '.env file',
                    'warn',
                    '.env was not found; only exported environment variables are used.'
                )
    );

    for (const [id, label, name] of [
        ['telegram-token', 'Telegram token', 'TELEGRAM_BOT_TOKEN'],
        ['gemini-key', 'Gemini API key', 'GEMINI_API_KEY'],
    ] as const) {
        checks.push(
            hasConfiguredValue(input.env[name])
                ? check(id, label, 'pass', `${name} is configured.`)
                : check(id, label, 'fail', `${name} is missing or still contains a placeholder.`)
        );
    }

    const ownerConfigured = [input.env.OWNER_TG_IDS, input.env.OWNER_IDENTITIES].some((value) =>
        (value || '')
            .split(',')
            .map((entry) => entry.trim())
            .some(hasConfiguredValue)
    );
    const bootstrapOwnerMode = isEnabled(input.env.BOOTSTRAP_OWNER_MODE);
    checks.push(
        ownerConfigured
            ? check('owner', 'Owner access', 'pass', 'At least one owner identity is configured.')
            : bootstrapOwnerMode
              ? check(
                    'owner',
                    'Owner access',
                    'warn',
                    'BOOTSTRAP_OWNER_MODE is open; configure an owner and turn it off after setup.'
                )
              : check('owner', 'Owner access', 'fail', 'Set OWNER_TG_IDS or OWNER_IDENTITIES before starting.')
    );
    if (bootstrapOwnerMode && ownerConfigured) {
        checks.push(
            check(
                'bootstrap-owner-mode',
                'Bootstrap access',
                'warn',
                'BOOTSTRAP_OWNER_MODE is still enabled; turn it off after setup.'
            )
        );
    }

    const timeZone = (input.env.TZ || '').trim();
    checks.push(
        !timeZone
            ? check('timezone', 'Timezone', 'warn', 'TZ is unset; UTC will depend on the host environment.')
            : isValidTimeZone(timeZone)
              ? check('timezone', 'Timezone', 'pass', `${timeZone} is valid.`)
              : check('timezone', 'Timezone', 'fail', `${timeZone} is not a valid IANA timezone.`)
    );

    const apiPortRaw = (input.env.PIPI_API_PORT || '').trim();
    const apiPort = apiPortRaw ? Number(apiPortRaw) : 0;
    if (!Number.isInteger(apiPort) || apiPort < 0 || apiPort > 65535) {
        checks.push(check('api', 'Read-only API', 'fail', 'PIPI_API_PORT must be an integer from 0 to 65535.'));
    } else if (apiPort > 0 && !hasConfiguredValue(input.env.PIPI_API_TOKEN)) {
        checks.push(check('api', 'Read-only API', 'fail', 'PIPI_API_TOKEN is required when PIPI_API_PORT is enabled.'));
    } else if (apiPort > 0 && !['127.0.0.1', 'localhost', '::1'].includes(input.env.PIPI_API_HOST || '127.0.0.1')) {
        checks.push(
            check(
                'api',
                'Read-only API',
                'warn',
                'The API binds beyond localhost; verify your proxy, firewall, and TLS settings.'
            )
        );
    } else {
        checks.push(
            check(
                'api',
                'Read-only API',
                'pass',
                apiPort > 0 ? 'The API has a token and a local bind.' : 'The API is disabled.'
            )
        );
    }

    checks.push(inspectNamedAsset('pack', (input.env.BOOTSTRAP_PACK || 'jeeves').trim(), input.cwd, io));
    checks.push(
        inspectNamedAsset('grounding', (input.env.BOOTSTRAP_GROUNDING || 'jeeves_personal').trim(), input.cwd, io)
    );

    const dataDir = path.resolve(input.cwd, input.env.DATA_DIR || 'data');
    if (io.exists(dataDir)) {
        checks.push(
            !io.isDirectory(dataDir)
                ? check('data-dir', 'Data directory', 'fail', `${dataDir} exists but is not a directory.`)
                : io.isWritable(dataDir)
                  ? check('data-dir', 'Data directory', 'pass', `${dataDir} is writable.`)
                  : check('data-dir', 'Data directory', 'fail', `${dataDir} is not writable.`)
        );
    } else {
        const ancestor = findExistingAncestor(dataDir, io);
        checks.push(
            ancestor && io.isDirectory(ancestor) && io.isWritable(ancestor)
                ? check('data-dir', 'Data directory', 'pass', `${dataDir} can be created on first start.`)
                : check(
                      'data-dir',
                      'Data directory',
                      'fail',
                      `${dataDir} cannot be created from the current filesystem permissions.`
                  )
        );
    }

    if (isEnabled(input.env.WHATSAPP_ENABLED)) {
        const missing = ['@whiskeysockets/baileys', '@hapi/boom'].filter(
            (packageName) => !io.canResolvePackage(packageName, input.cwd)
        );
        checks.push(
            missing.length === 0
                ? check('whatsapp', 'WhatsApp', 'pass', 'WhatsApp dependencies are available.')
                : check(
                      'whatsapp',
                      'WhatsApp',
                      'fail',
                      `WhatsApp is enabled but missing packages: ${missing.join(', ')}. Run pnpm install.`
                  )
        );
    }

    const discord = inspectOptionalChannel(
        'discord',
        'Discord',
        [input.env.DISCORD_BOT_TOKEN, input.env.DISCORD_CHANNEL_ID],
        ['discord.js'],
        input.cwd,
        io
    );
    if (discord) checks.push(discord);

    const gmail = inspectOptionalChannel(
        'gmail',
        'Gmail',
        [input.env.CONCIERGE_SMTP_HOST, input.env.CONCIERGE_SMTP_USER, input.env.CONCIERGE_SMTP_PASS],
        ['nodemailer'],
        input.cwd,
        io
    );
    if (gmail) checks.push(gmail);

    return checks;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
    const symbols: Record<DoctorStatus, string> = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' };
    const lines = ['Open PiPi doctor', ''];
    for (const item of checks) {
        lines.push(`[${symbols[item.status]}] ${item.label}: ${item.message}`);
    }

    const failures = checks.filter((item) => item.status === 'fail').length;
    const warnings = checks.filter((item) => item.status === 'warn').length;
    lines.push(
        '',
        failures === 0
            ? `Ready to start (${warnings} warning${warnings === 1 ? '' : 's'}).`
            : `Not ready: ${failures} check${failures === 1 ? '' : 's'} failed.`
    );
    if (failures === 0) lines.push('Next: pnpm dev');
    return lines.join('\n');
}

export function loadDoctorInput(cwd = process.cwd()): DoctorInput {
    const envPath = path.join(cwd, '.env');
    const envFileFound = fs.existsSync(envPath);
    let envFileError = false;
    let fileEnv: Record<string, string> = {};
    if (envFileFound) {
        try {
            fileEnv = dotenv.parse(fs.readFileSync(envPath));
        } catch {
            envFileError = true;
        }
    }
    return {
        cwd,
        nodeVersion: process.versions.node,
        envFileFound,
        envFileError,
        env: { ...fileEnv, ...process.env },
    };
}

export function isDoctorCli(argvEntry = process.argv[1], moduleFile = __filename): boolean {
    return require.main === module || Boolean(argvEntry && path.resolve(argvEntry) === path.resolve(moduleFile));
}

if (isDoctorCli()) {
    const checks = inspectDoctor(loadDoctorInput());
    const json = process.argv.includes('--json');
    if (json) {
        console.log(JSON.stringify({ ready: !checks.some((item) => item.status === 'fail'), checks }, null, 2));
    } else {
        console.log(formatDoctorReport(checks));
    }
    if (checks.some((item) => item.status === 'fail')) process.exitCode = 1;
}
