import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

describe('skill capability metadata', () => {
    it('exposes explicit metadata for risky and low-risk capabilities', () => {
        const webrunSource = fs.readFileSync(path.join(__dirname, 'webrun.skill.ts'), 'utf-8');
        const memorySource = fs.readFileSync(path.join(__dirname, 'memory.skill.ts'), 'utf-8');

        expect(webrunSource).toMatch(/run_mode:\s*'sidecar'/);
        expect(webrunSource).toMatch(/approval:\s*'explicit'/);
        expect(webrunSource).toMatch(/cost:\s*'high'/);

        expect(memorySource).toMatch(/run_mode:\s*'inline'/);
        expect(memorySource).toMatch(/approval:\s*'none'/);
        expect(memorySource).toMatch(/visibility:\s*'all'/);
        expect(memorySource).toMatch(/pack_tags:\s*\[[^\]]*'reporter'/);
    });
});
