export type WorkStatus = 'completed' | 'partial' | 'blocked' | 'failed';

export interface WorkContract {
    goal: string;
    context: string;
    context_refs: string[];
    must_collect: string[];
    decision_rights: string[];
    forbidden_actions: string[];
    fallback: string[];
    result_contract: string[];
}

export interface WorkResult {
    status: WorkStatus;
    summary: string;
    facts: Record<string, unknown>;
    blockers: string[];
    next_step: string | null;
    confidence: number;
}

function cleanList(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return values.map((value) => String(value).trim()).filter(Boolean);
}

export function createWorkContract(input: Partial<WorkContract> & Pick<WorkContract, 'goal'>): WorkContract {
    const goal = input.goal.trim();
    if (!goal) throw new Error('A delegated work contract requires a goal.');

    return {
        goal,
        context: input.context?.trim() || '',
        context_refs: cleanList(input.context_refs),
        must_collect: cleanList(input.must_collect),
        decision_rights: cleanList(input.decision_rights),
        forbidden_actions: cleanList(input.forbidden_actions),
        fallback: cleanList(input.fallback),
        result_contract: cleanList(input.result_contract),
    };
}

function clampConfidence(value: unknown): number {
    const number = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}

function parseJsonObject(text: string): Record<string, unknown> | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    const candidate = fenced || text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    if (!candidate.trim()) return null;

    try {
        const parsed = JSON.parse(candidate);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function parseWorkResult(text: string): WorkResult {
    const parsed = parseJsonObject(text);
    if (!parsed) {
        return {
            status: 'partial',
            summary: text.trim(),
            facts: {},
            blockers: ['Delegate did not return the requested structured result.'],
            next_step: null,
            confidence: 0,
        };
    }

    const status: WorkStatus = ['completed', 'partial', 'blocked', 'failed'].includes(String(parsed.status))
        ? (parsed.status as WorkStatus)
        : 'partial';

    return {
        status,
        summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
        facts:
            parsed.facts && typeof parsed.facts === 'object' && !Array.isArray(parsed.facts)
                ? (parsed.facts as Record<string, unknown>)
                : {},
        blockers: cleanList(parsed.blockers),
        next_step: typeof parsed.next_step === 'string' && parsed.next_step.trim() ? parsed.next_step.trim() : null,
        confidence: clampConfidence(parsed.confidence),
    };
}

export function renderWorkContract(contract: WorkContract): string {
    return JSON.stringify(contract, null, 2);
}
