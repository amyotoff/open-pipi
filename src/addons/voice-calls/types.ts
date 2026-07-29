/**
 * The contracts a delegated phone call runs on.
 *
 * A call is the clearest example of a subagent this runtime has: the
 * orchestrator cannot supervise it turn by turn, because the conversation
 * happens on a phone line at machine speed with a stranger. So the whole
 * relationship is two contracts — a task going in, a result coming back — and
 * everything the delegate is allowed to do has to be stated up front.
 *
 * That is the part worth copying if you are writing a different subagent. The
 * telephony is incidental.
 */

/** What kind of job the call is. Selects a template of sensible defaults. */
export type CallTaskType = 'booking' | 'appointment' | 'info_verification' | 'follow_up' | 'owner_relay';

/**
 * Who is on the other end.
 *
 * Calling a stranger on the owner's behalf and calling the owner directly are
 * different situations with different rules, and the delegate needs to know
 * which one it is in.
 */
export type CallMode = 'THIRD_PARTY_TASK_CALL' | 'DIRECT_OWNER_CALL';

/**
 * Everything the delegate is told before it starts.
 *
 * Read the four permission fields together: `allowed_actions` and
 * `decision_rights` say how far it may go, `forbidden_actions` and
 * `hard_blockers` say where it must stop. An unsupervised agent with only the
 * first pair will improvise its way into agreeing to something.
 */
export interface CallTaskPayload {
    call_mode: CallMode;
    task_type: CallTaskType;
    /** ISO 639-1 code, or omitted for auto-detection from the number. */
    expected_language?: string;
    service_context: string;
    contact_name: string;
    goal: string;
    /** Facts to bring into the conversation, one per line in the prompt. */
    important_details: string[];
    /** How far it may go on its own: budgets, time ranges, fees. */
    decision_rights?: string[];
    /** Lines it may not cross, however the conversation goes. */
    hard_blockers?: string[];
    /** What it must come back with. */
    must_collect: string[];
    allowed_actions: string[];
    forbidden_actions: string[];
    /** What to do when the goal turns out to be unreachable. */
    fallbacks: string[];
    /** Field name → expected shape, so the result can be checked rather than trusted. */
    result_contract: Record<string, string>;
}

/**
 * The task payload flattened to strings.
 *
 * Providers inject these into a prompt template, and a prompt template cannot
 * hold an array. Lists become newline-separated bullets, objects become JSON.
 */
export interface CallVariables {
    [key: string]: string;
    current_date: string;
    expected_language: string;
    language_directive: string;
    task_type: string;
    goal: string;
    service_context: string;
    contact_name: string;
    important_details: string;
    decision_rights: string;
    hard_blockers: string;
    must_collect: string;
    allowed_actions: string;
    forbidden_actions: string;
    fallback: string;
    result_contract: string;
}

/**
 * What comes back.
 *
 * Deliberately not a transcript. A transcript makes the orchestrator read a
 * conversation it did not have; this is the answer to "what happened, and what
 * do I do now" in a shape another agent can branch on.
 */
export interface CallResultContract {
    status: 'completed' | 'partial' | 'blocked' | 'no_answer' | 'failed';
    task_type: string;
    goal_achieved: boolean;
    summary: string;
    /** Task-specific facts the delegate was asked to collect. */
    facts_collected: Record<string, unknown>;
    /** Anything actually agreed to on the call. */
    agreements: Record<string, unknown>;
    blockers: string[];
    next_step: string | null;
    follow_up_needed: boolean;
    /** 0–1. Low means the delegate is guessing and a human should look. */
    confidence: number;
}

/** One field a provider should extract from the finished call. */
export interface AnalysisSchemaItem {
    name: string;
    type: 'string' | 'enum' | 'boolean' | 'number';
    description: string;
    required?: boolean;
    /** Enum only. */
    choices?: string[];
    /** String only, to steer the extraction. */
    examples?: string[];
}

/** What a finished call looks like before it is reduced to a result contract. */
export interface CallOutcome {
    transcript: string;
    duration_ms: number;
    /** The provider's own word for how the call ended. */
    status: string;
    summary: string;
    structuredResult?: CallResultContract;
    analysis?: CallAnalysis;
}

/** The provider's post-call extraction, if it does any. */
export interface CallAnalysis {
    call_successful?: boolean;
    call_summary?: string;
    custom_analysis_data?: Record<string, unknown>;
    user_sentiment?: string;
    in_voicemail?: boolean;
}

export interface CallOptions {
    payload: CallTaskPayload;
    /**
     * Who the delegate says it represents.
     *
     * Per call rather than per provider: one runtime serves several spaces, and
     * the household the assistant is calling for is a property of the
     * conversation, not of the phone line.
     */
    identity: GuardrailIdentity;
    /** Passed through to the provider untouched, for its own logs. */
    metadata?: Record<string, unknown>;
}

/** How the delegate refers to the person it is acting for. A name, never contact details. */
export interface GuardrailIdentity {
    ownerName: string;
}

/**
 * A telephony backend.
 *
 * Kept narrow on purpose: place a call, come back when it is over. Which voice,
 * which model, which carrier — all of that is the provider's business and none
 * of it reaches the skill.
 */
export interface VoiceProvider {
    readonly name: string;
    /** Whether its configuration is present and usable. */
    isConfigured(): boolean;
    placeCall(toNumber: string, options: CallOptions): Promise<CallOutcome>;
}

/** Returns a provider, or null when it is not configured. */
export type VoiceProviderFactory = () => VoiceProvider | null;
