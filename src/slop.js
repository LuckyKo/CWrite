/**
 * CWrite — Slop Detection Module
 * Detects repeated words/phrases during streaming and provides highlighting info.
 */

export class SlopDetector {
  constructor() {
    this.enabled = true;
    this.threshold = 3; // auto-stop after N consecutive repeated n-grams
    this.autoRollback = false;
    this.paragraphRollback = false;
  }

  configure({ enabled, threshold, autoRollback, paragraphRollback }) {
    if (enabled !== undefined) this.enabled = enabled;
    if (threshold !== undefined) this.threshold = threshold;
    if (autoRollback !== undefined) this.autoRollback = autoRollback;
    if (paragraphRollback !== undefined) this.paragraphRollback = paragraphRollback;
  }

  /**
   * Analyze text for n-gram repetition.
   * Checks for consecutive repeated n-grams (2-word to 8-word sequences)
   * at the END of the text (which is where streaming adds new tokens).
   *
   * @param {string} text - the full assistant message so far
   * @returns {{ slopDetected: boolean, severity: string, repeatedPhrase: string, highlightRanges: Array }}
   */
  analyze(text) {
    if (!this.enabled || !text) {
      return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [] };
    }

    // Tokenize into words with their positions in the original text
    const wordTokens = [];
    const regex = /\S+/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      wordTokens.push({
        word: match[0].toLowerCase().replace(/[.,!?;:'"(){}\[\]]/g, ''),
        start: match.index,
        end: match.index + match[0].length,
        original: match[0],
      });
    }

    if (wordTokens.length < 4) {
      return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [] };
    }

    let bestMatch = null;

    // Check n-grams from largest to smallest (prefer longer repeats)
    for (let n = Math.min(8, Math.floor(wordTokens.length / 2)); n >= 2; n--) {
      // Get the last n-gram
      const tailStart = wordTokens.length - n;
      const tailNgram = wordTokens.slice(tailStart).map(t => t.word).join(' ');

      // Count consecutive repeats backwards from the end
      let consecutiveCount = 1; // the tail itself counts as 1

      for (let i = tailStart - n; i >= 0; i -= n) {
        const chunk = wordTokens.slice(i, i + n).map(t => t.word).join(' ');
        if (chunk === tailNgram) {
          consecutiveCount++;
        } else {
          break;
        }
      }

      if (consecutiveCount >= 2) {
        // We found a repeat. Build highlight ranges.
        const highlightRanges = [];
        const totalRepeatedWords = consecutiveCount * n;
        const firstRepeatedWordIdx = wordTokens.length - totalRepeatedWords;

        for (let i = 0; i < totalRepeatedWords; i++) {
          const tokenIdx = firstRepeatedWordIdx + i;
          if (tokenIdx >= 0 && tokenIdx < wordTokens.length) {
            const token = wordTokens[tokenIdx];
            // Earlier repeats are milder, later ones are more severe
            const repeatNum = Math.floor(i / n); // which repeat (0-based)
            let severity;
            if (consecutiveCount >= this.threshold) {
              severity = repeatNum >= this.threshold - 1 ? 'severe' : (repeatNum >= 1 ? 'moderate' : 'mild');
            } else if (consecutiveCount >= this.threshold - 1) {
              severity = repeatNum >= 1 ? 'moderate' : 'mild';
            } else {
              severity = 'mild';
            }

            highlightRanges.push({
              start: token.start,
              end: token.end,
              severity,
            });
          }
        }

        const slopDetected = consecutiveCount >= this.threshold;
        const overallSeverity = slopDetected ? 'severe' :
          (consecutiveCount >= this.threshold - 1 ? 'moderate' : 'mild');

        bestMatch = {
          slopDetected,
          severity: overallSeverity,
          repeatedPhrase: tailNgram,
          highlightRanges,
          consecutiveCount,
        };

        break; // Use the longest n-gram match
      }
    }

    return bestMatch || { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [] };
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
      const cls = range.severity === 'severe' ? 'slop-severe' :
        range.severity === 'moderate' ? 'slop-moderate' : 'slop-mild';
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
