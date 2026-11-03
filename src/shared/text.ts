// Text normalization and fuzzy matching used by intent recognition and by the
// grammar builder (so what the recognizer can hear and what the matcher expects
// are produced by the same function).

const SPOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bc\s*plus\s*plus\b/g, 'c++'],
  [/\bc\s*sharp\b/g, 'c#'],
  [/\byou\s+tube\b/g, 'youtube'],
  [/\bleet\s+code\b/g, 'leetcode'],
  // "git hub" and how dictation commonly mishears it
  [/\b(?:git|get)\s*(?:hub|up)\b/g, 'github'],
  [/\bvs\s+code\b/g, 'vscode'],
  [/\bvisual\s+studio\s+code\b/g, 'vscode'],
  [/\brocket\s+chat\b/g, 'rocketchat'],
  [/\bstack\s+overflow\b/g, 'stackoverflow'],
];

const POLITE_PREFIXES = /^(?:(?:hey|okay|ok|so|um|uh|please|can you|could you|would you|will you|i want you to|i'd like you to|go ahead and|kindly)\s+)+/;
const POLITE_SUFFIXES = /(?:\s+(?:please|for me|now|right now|thanks|thank you))+$/;

/** Lowercase, strip punctuation (keeps + and # for "c++", "c#"), collapse whitespace. */
export function basicNormalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+#\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Canonical form for matching: spoken variants folded ("leet code" -> "leetcode"). */
export function canonical(text: string): string {
  let s = basicNormalize(text.replace(/\./g, ' '));
  for (const [re, rep] of SPOKEN_REPLACEMENTS) s = s.replace(re, rep);
  return s.replace(/\s+/g, ' ').trim();
}

/** Removes a leading wake word ("rog, open github" -> "open github"). */
export function stripWakeWord(text: string, wakeWords: readonly string[]): string {
  const s = canonical(text);
  const sorted = [...wakeWords].map(canonical).sort((a, b) => b.length - a.length);
  for (const w of sorted) {
    if (s === w) return '';
    if (s.startsWith(w + ' ')) return s.slice(w.length + 1).trim();
  }
  return s;
}

/** Canonical command text: wake word, politeness and filler removed. */
export function normalizeCommand(text: string, wakeWords: readonly string[] = []): string {
  return stripWakeWord(text, wakeWords).replace(POLITE_PREFIXES, '').replace(POLITE_SUFFIXES, '').trim();
}

/**
 * Spoken form for the recognizer grammar. SAPI does better with "leet code" than
 * "leetcode", so compounds are split back into words the lexicon knows.
 */
export function spokenForm(text: string): string {
  return basicNormalize(
    text
      .replace(/\./g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\+\+/g, ' plus plus ')
      .replace(/#/g, ' sharp '),
  )
    .replace(/\bleetcode\b/g, 'leet code')
    .replace(/\bgithub\b/g, 'git hub')
    .replace(/\bvscode\b/g, 'vs code')
    .replace(/\brocketchat\b/g, 'rocket chat')
    .replace(/\bstackoverflow\b/g, 'stack overflow')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[b.length]!;
}

/** Similarity in [0, 1] combining character edit distance and word overlap. */
export function similarity(a: string, b: string): number {
  const x = canonical(a);
  const y = canonical(b);
  if (!x || !y) return 0;
  if (x === y || x.replace(/ /g, '') === y.replace(/ /g, '')) return 1;
  const charSim = 1 - levenshtein(x, y) / Math.max(x.length, y.length);
  const xs = new Set(x.split(' '));
  const ys = new Set(y.split(' '));
  let overlap = 0;
  for (const w of xs) if (ys.has(w)) overlap++;
  const dice = (2 * overlap) / (xs.size + ys.size);
  return Math.max(charSim, 0.5 * charSim + 0.5 * dice);
}

export function slugify(text: string): string {
  return (
    basicNormalize(text)
      .replace(/[+#]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 48) || 'item'
  );
}
