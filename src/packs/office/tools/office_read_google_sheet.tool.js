function extractSpreadsheetId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const match = raw.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([^/?#]+)/);
    if (match?.[1]) return match[1];
    try {
        const parsed = new URL(raw);
        return parsed.searchParams.get('id');
    } catch {
        return null;
    }
}

function normalizeRange(range) {
    // Accept A1 notation like "Sheet1!A1:Z100" or a plain sheet name; default to first sheet
    return range ? String(range).trim() : 'A1:ZZ1000';
}

function formatValues(values) {
    if (!values || values.length === 0) return '(empty)';
    return values.map((row) => row.join('\t')).join('\n');
}

module.exports = {
    packTool: {
        id: 'office_read_google_sheet',
        title: 'Read Google Sheet',
        description:
            'Read cell values from a Google Sheets spreadsheet. Requires Google Drive to be connected (/gdrive auth).',
        parameters: {
            type: 'OBJECT',
            properties: {
                url: {
                    type: 'STRING',
                    description: 'Google Sheets URL, usually containing /spreadsheets/d/<id>.',
                },
                range: {
                    type: 'STRING',
                    description:
                        "A1 notation range, e.g. 'Sheet1!A1:D20' or 'A1:Z100'. Defaults to the full first sheet.",
                },
                max_rows: {
                    type: 'NUMBER',
                    description: 'Maximum number of rows to return. Defaults to 200.',
                },
            },
            required: ['url'],
        },
        execution: {
            run_mode: 'inline',
            capabilities: ['external_http'],
            approval: 'none',
            audit_default: 'errors',
        },
        async run(args, runtime) {
            const accessToken = runtime?.google_access_token;
            if (!accessToken) {
                return 'Google Drive is not connected. Run /gdrive auth to authorize.';
            }

            const url = String(args?.url || '').trim();
            const spreadsheetId = extractSpreadsheetId(url);
            if (!spreadsheetId) {
                return 'Invalid Google Sheets URL — could not extract spreadsheet ID.';
            }

            const range = normalizeRange(args?.range);
            const maxRows = Math.min(Math.max(Number(args?.max_rows) || 200, 1), 1000);

            const apiUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
            const response = await fetch(apiUrl, {
                headers: { Authorization: `Bearer ${accessToken}` },
            });

            if (!response.ok) {
                if (response.status === 403 || response.status === 401) {
                    return 'Sheets API denied access — token may not have permission to read this spreadsheet.';
                }
                if (response.status === 404) {
                    return 'Spreadsheet not found. Verify the URL and that the account has access.';
                }
                const errText = await response.text();
                return `Sheets API returned ${response.status}: ${errText}`;
            }

            const data = await response.json();
            const values = data?.values || [];
            const sliced = values.slice(0, maxRows);
            const truncated = values.length > maxRows;

            const formatted = formatValues(sliced);
            const lines = [
                'Google Sheets reading result',
                `Spreadsheet ID: ${spreadsheetId}`,
                `Range: ${data?.range || range}`,
                `Rows returned: ${sliced.length}${truncated ? ` (truncated from ${values.length})` : ''}`,
                '',
                formatted,
            ];

            return lines.join('\n');
        },
    },
};
