/**
 * CWrite — Slop Detection Module
 * Detects repeated words/phrases during streaming and provides highlighting info.
 */

export class SlopDetector {
  constructor() {
    this.enabled = true;
    this.threshold = 3; // auto-stop after N consecutive repeated n-grams
    this.minSequenceLength = 3;  // N: minimum words in sequence
    this.occurrenceThreshold = 2; // M: must repeat this many times to highlight
    this.autoRollback = false;
    this.paragraphRollback = false;
  }

  configure({ enabled, threshold, minSequenceLength, occurrenceThreshold, autoRollback, paragraphRollback }) {
    if (enabled !== undefined) this.enabled = enabled;
    if (threshold !== undefined) this.threshold = threshold;
    if (minSequenceLength !== undefined) this.minSequenceLength = minSequenceLength;
    if (occurrenceThreshold !== undefined) this.occurrenceThreshold = occurrenceThreshold;
    if (autoRollback !== undefined) this.autoRollback = autoRollback;
    if (paragraphRollback !== undefined) this.paragraphRollback = paragraphRollback;
  }

  /**
   * Analyze text for n-gram repetition at the TAIL (for streaming auto-stop).
   */
  analyze(text) {
    if (!this.enabled || !text) {
      return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [] };
    }

    const wordTokens = this.tokenize(text);
    if (wordTokens.length < 4) {
      return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [] };
    }

    const maxN = Math.min(12, Math.floor(wordTokens.length / 2));
    const minN = this.minSequenceLength;

    for (let n = maxN; n >= minN; n--) {
      const tailStart = wordTokens.length - n;
      const tailWords = wordTokens.slice(tailStart).map(t => t.word).join(' ');
      let consecutiveCount = 1;

      for (let i = tailStart - n; i >= 0; i -= n) {
        const chunk = wordTokens.slice(i, i + n).map(t => t.word).join(' ');
        if (chunk === tailWords) consecutiveCount++;
        else break;
      }

      if (consecutiveCount >= this.occurrenceThreshold) {
        const highlightRanges = [];
        const totalRepeatedWords = consecutiveCount * n;
        const startIdx = wordTokens.length - totalRepeatedWords;

        for (let i = 0; i < totalRepeatedWords; i++) {
          const tIdx = startIdx + i;
          const token = wordTokens[tIdx];
          const repeatNum = Math.floor(i / n);
          let severityNum = Math.min(6, Math.floor(n / 2) + repeatNum);
          highlightRanges.push({ start: token.start, end: token.end, severity: `level-${severityNum}` });
        }

        return {
          slopDetected: consecutiveCount >= this.threshold,
          severity: `level-${Math.min(6, Math.floor(n / 2) + consecutiveCount - 1)}`,
          repeatedPhrase: tailWords,
          highlightRanges,
          consecutiveCount,
        };
      }
    }

    return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [], consecutiveCount: 0 };
  }

  /**
   * Scan ENTIRE text for ALL consecutive repetitions (for Rendered View).
   */
  findSlop(text) {
    if (!this.enabled || !text) return [];

    const wordTokens = this.tokenize(text);
    if (wordTokens.length < 4) return [];

    const highlightRanges = [];
    const processedIndices = new Set();
    
    const minN = this.minSequenceLength;
    const maxN = 12;

    for (let n = maxN; n >= minN; n--) {
      for (let i = 0; i <= wordTokens.length - (n * 2); i++) {
        if (processedIndices.has(i)) continue;

        const ngram = wordTokens.slice(i, i + n).map(t => t.word).join(' ');
        let consecutiveCount = 1;
        
        for (let j = i + n; j <= wordTokens.length - n; j += n) {
          const chunk = wordTokens.slice(j, j + n).map(t => t.word).join(' ');
          if (chunk === ngram) consecutiveCount++;
          else break;
        }

        // Use occurrenceThreshold (M)
        if (consecutiveCount > this.occurrenceThreshold) {
          for (let c = 0; c < consecutiveCount; c++) {
            for (let w = 0; w < n; w++) {
              const idx = i + (c * n) + w;
              processedIndices.add(idx);
              const token = wordTokens[idx];
              const severityNum = Math.min(6, Math.floor(n / 2) + c);
              highlightRanges.push({ start: token.start, end: token.end, severity: `level-${severityNum}` });
            }
          }
          i += (consecutiveCount * n) - 1;
        }
      }
    }

    return highlightRanges;
  }

  tokenize(text) {
    const tokens = [];
    const regex = /\S+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      tokens.push({
        word: match[0].toLowerCase().replace(/[.,!?;:'"(){}\[\]]/g, ''),
        start: match.index,
        end: match.index + match[0].length,
        original: match[0],
      });
    }
    return tokens;
  }

  /**
   * Render plain text with slop highlight spans inserted.
   * This produces HTML from plain text — does NOT use markdown rendering,
   * so it should be used during streaming only.
   *
   * @param {string} text - plain text content
   * @param {Array} highlightRanges - from analyze(), sorted by start
   * @returns {string} HTML with slop spans
   */
  renderWithHighlights(text, highlightRanges) {
    if (!highlightRanges || highlightRanges.length === 0) {
      return null;
    }

    // Merge overlapping ranges and sort
    const sorted = [...highlightRanges].sort((a, b) => a.start - b.start);

    let html = '';
    let cursor = 0;

    for (const range of sorted) {
      // Add text before this range
      if (range.start > cursor) {
        html += escapeHtml(text.slice(cursor, range.start));
      }

      // Add highlighted word
      const cls = `slop-${range.severity}`;
      html += `<span class="${cls}">${escapeHtml(text.slice(range.start, range.end))}</span>`;
      cursor = range.end;
    }

    // Add remaining text after last highlight
    if (cursor < text.length) {
      html += escapeHtml(text.slice(cursor));
    }

    return html;
  }
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const slopDetector = new SlopDetector();
