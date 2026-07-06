import { describe, expect, it } from 'vitest';
import {
    normalizeAuditMode,
    normalizeToolCapabilities,
    defaultCapabilitiesForTool,
    deriveToolExecutionSpec,
} from './tool-execution';

describe('core/tool-execution', () => {
    describe('normalizeAuditMode', () => {
        it('passes through valid modes', () => {
            expect(normalizeAuditMode('off')).toBe('off');
            expect(normalizeAuditMode('errors')).toBe('errors');
            expect(normalizeAuditMode('all')).toBe('all');
        });

        it('falls back on invalid input', () => {
            expect(normalizeAuditMode('invalid')).toBe('errors');
            expect(normalizeAuditMode(null)).toBe('errors');
            expect(normalizeAuditMode(undefined, 'all')).toBe('all');
        });
    });

    describe('normalizeToolCapabilities', () => {
        it('returns empty for non-array input', () => {
            expect(normalizeToolCapabilities(null)).toEqual([]);
            expect(normalizeToolCapabilities('workspace_read')).toEqual([]);
        });

        it('filters unknown capabilities and deduplicates', () => {
            expect(normalizeToolCapabilities(['workspace_read', 'bogus', 'workspace_read'])).toEqual([
                'workspace_read',
            ]);
        });

        it('keeps all known capabilities', () => {
            const all = ['workspace_read', 'artifact_write', 'web_browse', 'external_http', 'shell_none'];
            expect(normalizeToolCapabilities(all)).toEqual(all);
        });
    });

    describe('defaultCapabilitiesForTool', () => {
        it('returns override for known tools', () => {
            expect(defaultCapabilitiesForTool('browse_web')).toEqual(['web_browse', 'external_http']);
            expect(defaultCapabilitiesForTool('workspace_save_artifact')).toEqual(['artifact_write']);
        });

        it('returns shell_none for unknown tools', () => {
            expect(defaultCapabilitiesForTool('some_random_tool')).toEqual(['shell_none']);
        });
    });

    describe('deriveToolExecutionSpec', () => {
        it('derives web search as inline', () => {
            const spec = deriveToolExecutionSpec('web', { operation: 'search' });
            expect(spec.run_mode).toBe('inline');
            expect(spec.approval).toBe('none');
            expect(spec.capabilities).toEqual(['external_http']);
        });

        it('derives web browse as sidecar with explicit approval', () => {
            const spec = deriveToolExecutionSpec('web', { operation: 'browse' });
            expect(spec.run_mode).toBe('sidecar');
            expect(spec.approval).toBe('explicit');
            expect(spec.capabilities).toEqual(['web_browse', 'external_http']);
        });

        it('derives file_search save_artifact with artifact_write', () => {
            const spec = deriveToolExecutionSpec('file_search', { operation: 'save_artifact' });
            expect(spec.capabilities).toEqual(['artifact_write']);
        });

        it('derives file_search read as workspace_read', () => {
            const spec = deriveToolExecutionSpec('file_search', { operation: 'list' });
            expect(spec.capabilities).toEqual(['workspace_read']);
        });

        it('derives api_tool create_workflow_artifact', () => {
            const spec = deriveToolExecutionSpec('api_tool', { operation: 'create_workflow_artifact' });
            expect(spec.capabilities).toEqual(['artifact_write']);
        });

        it('falls back to defaults for unknown tools', () => {
            const spec = deriveToolExecutionSpec('unknown_tool', {});
            expect(spec.run_mode).toBe('inline');
            expect(spec.approval).toBe('none');
            expect(spec.capabilities).toEqual(['shell_none']);
        });

        it('uses base overrides when provided', () => {
            const spec = deriveToolExecutionSpec(
                'custom_tool',
                {},
                {
                    run_mode: 'sandbox',
                    approval: 'explicit',
                    capabilities: ['workspace_read', 'artifact_write'],
                }
            );
            expect(spec.run_mode).toBe('sandbox');
            expect(spec.approval).toBe('explicit');
            expect(spec.capabilities).toEqual(['workspace_read', 'artifact_write']);
        });
    });
});
