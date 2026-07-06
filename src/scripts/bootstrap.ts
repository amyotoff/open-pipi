/**
 * Operator bootstrap script.
 *
 * One free-text description → grounding files + .env advice + smoke prompts.
 *
 * Usage:
 *   pnpm bootstrap
 *   echo "description" | pnpm bootstrap
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config({ quiet: true });

const GROUNDINGS_ROOT = path.join(__dirname, '../groundings');

interface BootstrapResult {
    slug: string;
    title: string;
    description: string;
    default_language: string;
    timezone: string | null;
    world_model: string;
    people: { name: string; role: string }[];
    operating_rules: string[];
    pack_id: string;
    smoke_prompts: string[];
}

const EXTRACTION_PROMPT = `You are configuring a personal AI assistant. Extract structured configuration from the operator description below.

Return a JSON object with exactly these fields (no markdown, no code blocks, just valid JSON):
{
  "slug": "short_identifier (lowercase, underscores, max 20 chars, e.g. family_home or acme_team)",
  "title": "Human-readable title for this assistant space",
  "description": "One tagline sentence (10-15 words) describing what the assistant does",
  "default_language": "ru or en based on the description language",
  "timezone": "IANA timezone string (e.g. Europe/Moscow) or null if not mentioned",
  "world_model": "2-3 sentences describing this space purpose and context, written in second person for the assistant",
  "people": [{"name": "person name", "role": "their role or relationship"}],
  "operating_rules": ["rule 1", "rule 2"],
  "pack_id": "jeeves (personal/family/team general assistant), office (professional/corporate), reporter (news/research), tutor (education)",
  "smoke_prompts": ["test question 1", "test question 2", "test question 3"]
}

Operator description:
`;

async function extractConfig(description: string): Promise<BootstrapResult> {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not set. Add it to your .env file.');
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [{ role: 'user', parts: [{ text: EXTRACTION_PROMPT + description }] }],
        config: { temperature: 0.3 },
    });

    const text = (response as any).text?.trim() || '';
    if (!text) throw new Error('Empty response from Gemini.');

    // Strip markdown code fences if model wrapped the JSON
    const clean = text
        .replace(/^```(?:json)?\n?/, '')
        .replace(/\n?```$/, '')
        .trim();
    return JSON.parse(clean) as BootstrapResult;
}

function writeGroundingFiles(data: BootstrapResult): string {
    const dir = path.join(GROUNDINGS_ROOT, data.slug);
    fs.mkdirSync(dir, { recursive: true });

    const meta = {
        id: data.slug,
        title: data.title,
        description: data.description,
        default_language: data.default_language,
        timezone: data.timezone,
        memory_focus: ['commitments', 'preferences', 'deadlines', 'practical context'],
        attention_bias: [
            'conflicting instructions',
            'forgotten promises',
            'missing owners',
            'time-sensitive follow-through',
        ],
    };

    fs.writeFileSync(
        path.join(dir, 'grounding.md'),
        `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${data.world_model}\n`
    );

    const peopleLines = data.people.map((p) => `## ${p.name}\nRole: ${p.role}`).join('\n\n');
    fs.writeFileSync(path.join(dir, 'people.md'), peopleLines + '\n');

    const rulesLines = data.operating_rules.map((r) => `- ${r}`).join('\n');
    fs.writeFileSync(path.join(dir, 'operating.md'), rulesLines + '\n');

    fs.writeFileSync(path.join(dir, 'glossary.md'), '');

    return dir;
}

async function readDescription(): Promise<string> {
    if (!process.stdin.isTTY) {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
            chunks.push(chunk);
        }
        return Buffer.concat(chunks).toString('utf-8').trim();
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => {
        console.log('\nBootstrap your assistant.\n');
        console.log('Describe it in one paragraph: who it is for, main job-to-be-done,');
        console.log('language, key people, any standing rules or constraints.\n');
        process.stdout.write('> ');
        rl.once('line', (line) => {
            rl.close();
            resolve(line.trim());
        });
    });
}

async function main() {
    const description = await readDescription();

    if (!description) {
        console.error('No description provided.');
        process.exit(1);
    }

    console.log('\nExtracting configuration with Gemini...');

    let data: BootstrapResult;
    try {
        data = await extractConfig(description);
    } catch (err: any) {
        console.error('Extraction failed:', err.message);
        process.exit(1);
    }

    const dir = writeGroundingFiles(data);

    console.log(`\nGrounding written to:\n  ${dir}\n`);
    console.log('Add to your .env:');
    console.log(`  BOOTSTRAP_PACK=${data.pack_id}`);
    console.log(`  BOOTSTRAP_GROUNDING=${data.slug}`);
    console.log('\nSmoke test prompts (try these after deploy):');
    data.smoke_prompts.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
    console.log('');
}

main().catch((err) => {
    console.error(err.message);
    process.exit(1);
});
