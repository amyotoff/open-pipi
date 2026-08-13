/**
 * How the Brain Layer talks to a model, and what happens when the budget runs out.
 *
 * The import is deliberately lazy. `llm.ts` reaches the skill registry through the tool
 * executor, and the registry loads `brain.skill.ts`, so a static import here would close
 * the cycle llm → tool-executor → skills → brain-ingest → llm. Resolving the module at
 * call time keeps the graph acyclic at load time and makes the model easy to stub in tests.
 */

export type BrainModelMode = 'executor' | 'advisor';

export interface BrainModelRequest {
    system: string;
    prompt: string;
    mode: BrainModelMode;
    spaceId?: string;
    temperature?: number;
}

/**
 * Raised when the daily model budget is gone, or the model is otherwise unreachable.
 * Callers leave the work queued rather than dropping it: a source with no page is a lint
 * finding, which is the correct visible end state (D13 in docs/brain-wiki-plan.md).
 */
export class BrainBudgetError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BrainBudgetError';
    }
}

export async function generateBrainText(request: BrainModelRequest): Promise<string> {
    const { GEMINI_API_KEY } = await import('../config');
    if (!GEMINI_API_KEY?.trim()) {
        throw new BrainBudgetError('no model is configured for this install');
    }

    const { generateOneShotText } = await import('./llm');
    const { text, blocked } = await generateOneShotText(request);
    if (blocked) throw new BrainBudgetError(blocked);
    return text;
}

/** Models wrap JSON in code fences more often than not. */
export function parseModelJson<T>(text: string): T | null {
    const cleaned = text
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/```\s*$/, '')
        .trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return null;

    try {
        return JSON.parse(cleaned.substring(start, end + 1)) as T;
    } catch {
        return null;
    }
}
