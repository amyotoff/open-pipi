function extractGoogleDocId(input) {
    const raw = String(input || '').trim();
    if (!raw) return null;
    const pathMatch = raw.match(/\/document\/(?:u\/\d+\/)?d\/([^/?#]+)/);
    if (pathMatch?.[1]) return pathMatch[1];
    try {
        const parsed = new URL(raw);
        return parsed.searchParams.get('id');
    } catch {
        return null;
    }
}

// Fetch the document's end-of-content index so we can append after it
async function getDocEndIndex(docId, accessToken) {
    const response = await fetch(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
        throw new Error(`Docs API returned ${response.status} when fetching document structure.`);
    }
    const doc = await response.json();
    // body.content is an array of StructuralElement; last element's endIndex is the doc length
    const content = doc?.body?.content;
    if (!Array.isArray(content) || content.length === 0) return 1;
    return (content[content.length - 1]?.endIndex ?? 1) - 1;
}

async function appendToDoc(docId, text, accessToken) {
    const endIndex = await getDocEndIndex(docId, accessToken);

    const body = {
        requests: [
            {
                insertText: {
                    location: { index: endIndex },
                    text: (endIndex > 1 ? '\n' : '') + text,
                },
            },
        ],
    };

    const response = await fetch(
        `https://docs.googleapis.com/v1/documents/${encodeURIComponent(docId)}:batchUpdate`,
        {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        }
    );

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Docs batchUpdate returned ${response.status}: ${errText}`);
    }
}

async function createDoc(title, text, accessToken) {
    // Create via Docs API
    const createResponse = await fetch('https://docs.googleapis.com/v1/documents', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title }),
    });

    if (!createResponse.ok) {
        const errText = await createResponse.text();
        throw new Error(`Docs create returned ${createResponse.status}: ${errText}`);
    }

    const created = await createResponse.json();
    const docId = created.documentId;

    if (text) {
        await appendToDoc(docId, text, accessToken);
    }

    return docId;
}

module.exports = {
    packTool: {
        id: 'office_write_google_doc',
        title: 'Write to Google Doc',
        description:
            'Append text to an existing Google Doc or create a new one. Requires Google Drive to be connected (/gdrive auth).',
        parameters: {
            type: 'OBJECT',
            properties: {
                url: {
                    type: 'STRING',
                    description:
                        'Google Docs URL of the document to append to. Omit to create a new document.',
                },
                title: {
                    type: 'STRING',
                    description: 'Title for the new document (only used when creating; ignored when url is provided).',
                },
                text: {
                    type: 'STRING',
                    description: 'Text content to append or write.',
                },
            },
            required: ['text'],
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

            const text = String(args?.text || '').trim();
            if (!text) return 'Nothing to write — text is empty.';

            const url = String(args?.url || '').trim();

            if (url) {
                const docId = extractGoogleDocId(url);
                if (!docId) return 'Invalid Google Docs URL — could not extract document ID.';

                try {
                    await appendToDoc(docId, text, accessToken);
                    return `Appended ${text.length} characters to Google Doc (ID: ${docId}).`;
                } catch (err) {
                    return `Failed to append to Google Doc: ${err instanceof Error ? err.message : String(err)}`;
                }
            } else {
                const title = String(args?.title || 'Untitled').trim() || 'Untitled';
                try {
                    const docId = await createDoc(title, text, accessToken);
                    const docUrl = `https://docs.google.com/document/d/${docId}/edit`;
                    return `Created new Google Doc: ${title}\nURL: ${docUrl}\nContent (${text.length} chars) written.`;
                } catch (err) {
                    return `Failed to create Google Doc: ${err instanceof Error ? err.message : String(err)}`;
                }
            }
        },
    },
};
