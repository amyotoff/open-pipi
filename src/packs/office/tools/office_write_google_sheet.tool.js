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

// Parse a simple CSV / TSV string into a 2D array of strings
function parseRows(text) {
    return text
        .split('\n')
        .map((line) => line.split('\t'))
        .filter((row) => row.some((cell) => cell.trim() !== ''));
}

module.exports = {
    packTool: {
        id: 'office_write_google_sheet',
        title: 'Write to Google Sheet',
        description:
            'Write or update cell values in a Google Sheets spreadsheet. Requires Google Drive to be connected (/gdrive auth).',
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
                        "A1 notation starting cell or range, e.g. 'Sheet1!A1' or 'A1'. The data will be written from this cell.",
                },
                values: {
                    type: 'ARRAY',
                    description:
                        'A 2D array of cell values to write, e.g. [["Name","Score"],["Alice","95"]]. Each inner array is one row.',
                    items: {
                        type: 'ARRAY',
                        items: { type: 'STRING' },
                    },
                },
                tsv: {
                    type: 'STRING',
                    description:
                        'Alternative to values: tab-separated rows (rows separated by newlines). Used when values is not provided.',
                },
            },
            required: ['url', 'range'],
        },
        execution: {
            run_mode: 'sandbox',
            capabilities: ['external_http'],
            approval: 'explicit',
            audit_default: 'all',
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

            const range = String(args?.range || 'A1').trim();

            let rowData;
            if (Array.isArray(args?.values)) {
                rowData = args.values.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)]));
            } else if (args?.tsv) {
                rowData = parseRows(String(args.tsv));
            } else {
                return 'No data to write — provide either values (2D array) or tsv.';
            }

            if (rowData.length === 0) return 'Nothing to write — data is empty.';

            const body = {
                range,
                majorDimension: 'ROWS',
                values: rowData,
            };

            const apiUrl =
                `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;

            const response = await fetch(apiUrl, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                if (response.status === 403 || response.status === 401) {
                    return 'Sheets API denied write access — token may not have permission to edit this spreadsheet.';
                }
                const errText = await response.text();
                return `Sheets API returned ${response.status}: ${errText}`;
            }

            const result = await response.json();
            const updatedCells = result?.updatedCells ?? rowData.flat().length;
            return `Wrote ${rowData.length} row(s), ${updatedCells} cell(s) to ${result?.updatedRange || range} in spreadsheet ${spreadsheetId}.`;
        },
    },
};
