const SAFE_CONTENT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function isSafeContentId(value: string): boolean {
    return SAFE_CONTENT_ID_PATTERN.test(value);
}
