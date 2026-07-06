import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, DATA_DIR: `/tmp/open-pipi-scheduler-${Date.now()}` };
});

afterEach(async () => {
    try {
        const db = await import('./db');
        db.closeDatabase();
    } catch {}
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.resetModules();
});

describe('task-scheduler', () => {
    it('reseeds active spaces once on startup and registers assistant tasks', async () => {
        vi.resetModules();

        const cronSchedule = vi.fn(() => ({ stop: vi.fn() }));
        const ensureDefaultAssistantTasksForActiveSpaces = vi.fn(() => 2);
        const registerScheduledTasks = vi.fn(() => 5);

        vi.doMock('node-cron', () => ({
            default: {
                schedule: cronSchedule,
                validate: vi.fn(() => true),
            },
            schedule: cronSchedule,
            validate: vi.fn(() => true),
        }));
        vi.doMock('./core/tasks', () => ({
            ensureDefaultAssistantTasksForActiveSpaces,
            registerScheduledTasks,
        }));
        vi.doMock('./agents/sysadmin', () => ({
            runSystemHealthCheck: vi.fn(async () => undefined),
            runDatabaseBackup: vi.fn(async () => undefined),
        }));
        vi.doMock('./agents/reminders', () => ({ checkReminders: vi.fn(async () => undefined) }));
        vi.doMock('./core/healthcheck', () => ({ runHeartbeat: vi.fn(async () => undefined) }));
        vi.doMock('./db', async () => {
            const actual = await vi.importActual<typeof import('./db')>('./db');
            return {
                ...actual,
                cleanupSystemMetricsHistory: vi.fn(() => 0),
                cleanupToolExecutionLogs: vi.fn(() => 0),
                cleanupToolLogs: vi.fn(() => 0),
            };
        });

        const scheduler = await import('./task-scheduler');
        scheduler.startTaskScheduler();

        expect(ensureDefaultAssistantTasksForActiveSpaces).toHaveBeenCalledTimes(1);
        expect(registerScheduledTasks).toHaveBeenCalledTimes(1);
        expect(cronSchedule).toHaveBeenCalled();
    });
});
