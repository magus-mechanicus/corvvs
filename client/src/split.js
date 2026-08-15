/**
 * A "good enough for TTS" sentence splitter — not a linguistic tokenizer.
 *
 * Exists because the engine caps requests at CORVVS_MAX_CHARS (5000 by default) and has
 * no streaming for a single long call, so any caller reading a full article has to chunk
 * it themselves. Every consumer would otherwise write a slightly-wrong `text.split('.')`
 * that breaks on "Dr. Smith" and "3.14" — this ships one correct-enough implementation
 * instead.
 *
 * Known limitation: doesn't special-case runs of initials ("J. K. Rowling" splits into
 * three pieces). Rare enough in practice not to be worth the complexity it'd add; if it
 * matters for your text, pre/post-process around it.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc',
  'approx', 'no', 'inc', 'ltd', 'co', 'corp', 'fig', 'vol', 'pg', 'pp',
  'ave', 'blvd', 'dept', 'est', 'gov', 'univ', 'ca', 'cf',
]);

/**
 * @param {string} text
 * @returns {string[]} Trimmed, non-empty sentences, in order.
 */
export function splitSentences(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];

  const sentences = [];
  let start = 0;

  // A run of .!? optionally followed by closing quotes/brackets, then whitespace (or
  // end of string). `match.index` is where the punctuation run begins.
  const boundary = /[.!?]+(['")\]]*)(\s+|$)/g;
  let match;

  while ((match = boundary.exec(trimmed))) {
    const end = match.index + match[0].length;
    const before = trimmed.slice(start, match.index);
    const lastWord = (before.match(/(\S+)$/)?.[1] || '').replace(/\.+$/, '').toLowerCase();

    const isAbbreviation = ABBREVIATIONS.has(lastWord);
    // "3.14" — a digit immediately on both sides of the punctuation.
    const isDecimal = /\d$/.test(before) && /^\d/.test(trimmed.slice(end));

    if (isAbbreviation || isDecimal) continue; // keep accumulating past this boundary

    const candidate = trimmed.slice(start, end).trim();
    if (candidate) sentences.push(candidate);
    start = end;
  }

  const rest = trimmed.slice(start).trim();
  if (rest) sentences.push(rest);

  return sentences;
}
