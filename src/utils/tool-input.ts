export function normalizeArrayInput<T = unknown>(value: unknown): T[] {
    if (Array.isArray(value)) {
        return value as T[];
    }

    if (value == null) {
        return [];
    }

    return [value as T];
}

export function normalizeStringArray(value: unknown): string[] {
    return normalizeArrayInput(value)
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
}

export function normalizeNumberArray(value: unknown): number[] {
    return normalizeArrayInput(value).filter(
        (item): item is number => typeof item === 'number' && Number.isFinite(item)
    );
}

export function normalizeEnumArray<const T extends string>(value: unknown, allowed: readonly T[]): T[] {
    const allowedValues = new Set(allowed);

    return normalizeArrayInput(value).filter(
        (item): item is T => typeof item === 'string' && allowedValues.has(item as T)
    );
}
