export type GroundingOverrideKind = 'person' | 'place' | 'rule' | 'org' | 'glossary';

export interface GroundingPack {
    id: string;
    title: string;
    description?: string | null;
    default_language?: string | null;
    timezone?: string | null;
    memory_focus: string[];
    attention_bias: string[];
    grounding_text: string;
    people_text: string;
    operating_text: string;
    glossary_text: string;
    source: 'installable' | 'static';
    grounding_root: string | null;
}

export interface InstallableGroundingMeta {
    id: string;
    title: string;
    description?: string | null;
    default_language?: string | null;
    timezone?: string | null;
    memory_focus?: string[];
    attention_bias?: string[];
}

export interface GroundingOverride {
    id: number;
    space_id: string;
    kind: GroundingOverrideKind;
    subject: string;
    content: string;
    status: 'active' | 'inactive';
    created_by: string | null;
    created_at: string;
    updated_at: string;
}
