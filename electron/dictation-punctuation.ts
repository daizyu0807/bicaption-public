/**
 * Punctuation-only polish. The on-device model is asked to add punctuation, but only the positions of its
 * punctuation are kept: they are mapped back onto the caller's own text, so the result has exactly the original
 * characters whatever the model did (dropped a sentence-final particle, translated a word, emitted junk).
 */

const MARKS = '，。？！、：；';
const MARK_SET = new Set(MARKS);
const SENTENCE_END = new Set('。？！');
// Sentence-final particles: when the model leaves one out, its mark still belongs behind the particle.
const FINAL_PARTICLES = new Set('了啊吧呢嗎喔耶哦呀啦的都');

export function stripFullWidthMarks(text: string) {
  return text.replace(new RegExp(`[${MARKS}]`, 'g'), '');
}

export function longestCommonAlignment(a: string[], b: string[]) {
  // Classic LCS with a back-trace; inputs are one dictation (a few hundred characters at most).
  const rows = a.length + 1;
  const cols = b.length + 1;
  const table = Array.from({ length: rows }, () => new Uint16Array(cols));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { pairs.push([i, j]); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

/**
 * Put the model's punctuation into `source`, keeping whatever full-width marks `source` already has (the union of both).
 * A mark the model placed right after a character it dropped moves behind that dropped run, so it lands at the end
 * of the clause instead of in front of a stray particle.
 */
export function transplantPunctuation(source: string, modelOutput: string) {
  // Split the source into its own characters and the marks it already carries (keyed by the preceding character).
  const sourceChars: string[] = [];
  const existingMarks = new Map<number, string>();
  for (const char of source) {
    if (MARK_SET.has(char)) {
      if (sourceChars.length > 0) {
        const index = sourceChars.length - 1;
        existingMarks.set(index, (existingMarks.get(index) ?? '') + char);
      }
    } else {
      sourceChars.push(char);
    }
  }
  const outputChars: string[] = [];
  const marksAfterOutput = new Map<number, string>();
  for (const char of modelOutput) {
    if (MARK_SET.has(char)) {
      if (outputChars.length > 0) {
        const index = outputChars.length - 1;
        marksAfterOutput.set(index, (marksAfterOutput.get(index) ?? '') + char);
      }
    } else if (!/\s/u.test(char)) {
      outputChars.push(char);
    }
  }
  const comparableIndexes: number[] = [];
  sourceChars.forEach((char, index) => { if (!/\s/u.test(char)) comparableIndexes.push(index); });
  const pairs = longestCommonAlignment(comparableIndexes.map(index => sourceChars[index]), outputChars);
  const marksAfterSource = new Map<number, string>(existingMarks);
  const addMark = (index: number, mark: string) => marksAfterSource.set(index, (marksAfterSource.get(index) ?? '') + mark);
  for (let k = 0; k < pairs.length; k += 1) {
    const [sourceComparable, outputIndex] = pairs[k];
    const mark = marksAfterOutput.get(outputIndex);
    if (!mark) continue;
    // Skip over source characters the model dropped right after this matched one.
    const nextMatched = k + 1 < pairs.length ? pairs[k + 1][0] : comparableIndexes.length;
    let target = sourceComparable;
    const droppedRun = nextMatched - sourceComparable - 1;
    const outputGap = k + 1 < pairs.length ? pairs[k + 1][1] - outputIndex - 1 : 0;
    if (droppedRun > 0 && droppedRun <= 2 && outputGap === 0) {
      const dropped = comparableIndexes.slice(sourceComparable + 1, nextMatched).map(index => sourceChars[index]);
      if (dropped.every(char => FINAL_PARTICLES.has(char))) target = nextMatched - 1;
    }
    addMark(comparableIndexes[target], mark);
  }
  let result = '';
  sourceChars.forEach((char, index) => {
    result += char;
    const mark = marksAfterSource.get(index);
    if (mark) result += [...new Set(mark)].join('');
  });
  return result;
}

/**
 * Tidy the transplant result: no doubled marks, no mark at the start, and the existing convention that a dictation
 * does not end in a model-added period or comma (a final ? or ! carries meaning and stays, as does any ending mark
 * the text already had).
 */
export function finishPunctuation(text: string, original = '') {
  text = applyQuestionMarks(text);
  // Full-width marks carry their own spacing: drop the blanks the recogniser left around the spots they landed on.
  let result = text.replace(new RegExp(`\\s*([${MARKS}])\\s*`, 'g'), '$1')
    .replace(new RegExp(`([${MARKS}])[${MARKS}]+`, 'g'), '$1').replace(new RegExp(`^[${MARKS}]+`), '');
  if (!MARK_SET.has([...original.trimEnd()].pop() ?? '')) result = result.replace(/[，。、：；]+$/u, '');
  return result;
}

export function hasSentenceEnd(text: string) {
  return [...text].some(char => SENTENCE_END.has(char));
}

const QUESTION_WORDS = /什麼|為什麼|怎麼樣|怎麼|怎樣|哪裡|哪個|哪一個|哪些|誰|幾點|幾個|多少|(?<!還)是不是|有沒有|可不可以|能不能|會不會|要不要|對不對|好不好|行不行/u;
// A clause that reports or hedges a question ("我不知道為什麼", "他問我什麼時候有空") is a statement.
const NOT_A_QUESTION = /不知道|想知道|不清楚|不確定|不管|無論|不論|隨便|問我|告訴|看看|查一下|了解/u;
const A_NOT_A = /是不是|有沒有|可不可以|能不能|會不會|要不要|對不對|好不好|行不行/u;
const QUESTION_WORD_TAIL = 8;
// Text after an A-not-A word that shows the clause went on as a statement ("明天要不要開會我覺得可以").
const STATEMENT_TAIL = /我覺得|我想|我認為|我說|然後|所以|但是|因為/u;

/**
 * The on-device model almost never writes a question mark, so questions are marked by rule: a clause ending in 嗎 or 呢,
 * and the last clause of the text (or one that would end in a period) when a question word sits near its end.
 */
export function applyQuestionMarks(text: string) {
  let result = text
    .replace(/嗎(?!啡)[，。、：；？]?/gu, '嗎？')
    .replace(/呢(?=[，。、：；]|$)/gu, '呢？');
  const clauses = result.match(new RegExp(`[^${MARKS}]+[${MARKS}]?`, 'gu')) ?? [];
  if (clauses.length === 0) return result;
  result = clauses.map((clause, index) => {
    const body = clause.replace(new RegExp(`[${MARKS}]$`), '');
    const mark = clause.slice(body.length);
    const isLast = index === clauses.length - 1;
    if (!isLast && mark !== '。') return clause;
    if (mark === '？' || mark === '！' || NOT_A_QUESTION.test(body)) return clause;
    const match = QUESTION_WORDS.exec(body);
    if (!match) return clause;
    const tail = body.slice(match.index + match[0].length);
    if (tail.length > QUESTION_WORD_TAIL || (A_NOT_A.test(match[0]) && STATEMENT_TAIL.test(tail))) return clause;
    return `${body}？`;
  }).join('');
  return result;
}
