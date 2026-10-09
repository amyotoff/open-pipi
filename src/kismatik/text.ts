/**
 * Russian-first lexical normalisation. FTS5's unicode61 tokenizer folds case
 * but does not stem, so "проектор" and "проектора" would never meet. Text is
 * stemmed here, in JS, into a separate column that FTS indexes.
 */

const snowball = require('snowball-stemmers') as {
    newStemmer(language: string): { stem(word: string): string };
};

const russian = snowball.newStemmer('russian');
const english = snowball.newStemmer('english');

const CYRILLIC = /[а-я]/;
const TOKEN = /[\p{L}\p{N}]+/gu;

export function tokenize(text: string): string[] {
    return (text.toLowerCase().replace(/ё/g, 'е').match(TOKEN) || []).filter((token) => token.length >= 2);
}

export function stemToken(token: string): string {
    if (/^\d+$/.test(token)) return token;
    return CYRILLIC.test(token) ? russian.stem(token) : english.stem(token);
}

export function stemText(text: string): string {
    return tokenize(text).map(stemToken).join(' ');
}

// Question words and fillers match half the chat and drown the real terms in an OR query.
const QUERY_STOPWORDS = new Set(
    (
        'кто что где когда как какой какая какие каком почему зачем сколько чей ли же бы то это этот эта эти ' +
        'у в во на по за из от до для про о об при с со к ко и а но или да нет не ни мы вы они он она оно я ты ' +
        'нас вас нам вам их его ее мне меня тебе есть был была были будет можно нужно надо знает знают ' +
        'кого чего чем кому кем там тут здесь уже еще ещё все всё вообще пожалуйста подскажите ' +
        'the a an is are was were do does did who what where when how which of to in on for and or with'
    ).split(' ')
);

/** An OR query over stems; FTS5 syntax characters cannot survive tokenisation. */
export function toStemQuery(text: string, maxTerms = 16): string {
    const tokens = tokenize(text);
    const meaningful = tokens.filter((token) => !QUERY_STOPWORDS.has(token));
    const stems = [...new Set((meaningful.length ? meaningful : tokens).map(stemToken))].filter(
        (stem) => stem.length >= 2
    );
    return stems
        .slice(0, maxTerms)
        .map((stem) => `"${stem}"`)
        .join(' OR ');
}

export function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
