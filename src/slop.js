/**
 * CWrite — Slop Detection Module
 * Detects repeated words/phrases (n-grams) and provides highlighting info.
 *
 * Two entry points:
 *   analyze(text)  — tail-focused scan for streaming auto-stop
 *   findSlop(text) — full-text frequency-map scan for rendered view
 */

export class SlopDetector {
  constructor() {
    this.enabled = true;
    this.threshold = 3;          // auto-stop after N consecutive repeated n-grams (streaming)
    this.minSequenceLength = 3;  // minimum words in an n-gram
    this.occurrenceThreshold = 2; // must repeat >= this many times to flag
    this.maxDistance = 0;         // max word-distance between occurrences (0 = unlimited)
    this.autoRollback = false;
    this.paragraphRollback = false;
  }

  configure({ enabled, threshold, minSequenceLength, occurrenceThreshold, maxDistance, autoRollback, paragraphRollback }) {
    if (enabled !== undefined) this.enabled = enabled;
    if (threshold !== undefined) this.threshold = threshold;
    if (minSequenceLength !== undefined) this.minSequenceLength = minSequenceLength;
    if (occurrenceThreshold !== undefined) this.occurrenceThreshold = occurrenceThreshold;
    if (maxDistance !== undefined) this.maxDistance = maxDistance;
    if (autoRollback !== undefined) this.autoRollback = autoRollback;
    if (paragraphRollback !== undefined) this.paragraphRollback = paragraphRollback;
  }

  /**
   * Analyze text for n-gram repetition at the TAIL (for streaming auto-stop).
   * This checks whether the most recent words form a repeating loop.
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
          const severityNum = this._severity(n, consecutiveCount, repeatNum);
          highlightRanges.push({ start: token.start, end: token.end, severity: `level-${severityNum}` });
        }

        return {
          slopDetected: consecutiveCount >= this.threshold,
          severity: `level-${this._severity(n, consecutiveCount, consecutiveCount - 1)}`,
          repeatedPhrase: tailWords,
          highlightRanges,
          consecutiveCount,
        };
      }
    }

    return { slopDetected: false, severity: 'none', repeatedPhrase: '', highlightRanges: [], consecutiveCount: 0 };
  }

  /**
   * Scan ENTIRE text for ALL repeated n-grams (for Rendered View).
   *
   * Algorithm: frequency-map approach.
   *   For each n-gram size (largest first), build a map of ngram → [positions].
   *   Flag any n-gram that appears >= occurrenceThreshold times.
   *   Claimed token indices are skipped at smaller n-gram sizes (longest match wins).
   *   When maxDistance > 0, only groups of occurrences where each pair is
   *   within maxDistance words of each other are considered.
   */
  findSlop(text) {
    if (!this.enabled || !text) return [];

    const wordTokens = this.tokenize(text);
    if (wordTokens.length < this.minSequenceLength * 2) return [];

    const highlightRanges = [];
    const claimedIndices = new Set();

    const minN = this.minSequenceLength;
    const maxN = Math.min(12, Math.floor(wordTokens.length / 2));

    for (let n = maxN; n >= minN; n--) {
      // Build frequency map: ngram-string → array of start-token-indices
      const ngramPositions = new Map();

      for (let i = 0; i <= wordTokens.length - n; i++) {
        // Skip if ANY token in this window is already claimed by a larger match
        let anyClaimed = false;
        for (let w = 0; w < n; w++) {
          if (claimedIndices.has(i + w)) { anyClaimed = true; break; }
        }
        if (anyClaimed) continue;

        const key = wordTokens.slice(i, i + n).map(t => t.word).join(' ');
        if (!ngramPositions.has(key)) {
          ngramPositions.set(key, []);
        }
        ngramPositions.get(key).push(i);
      }

      // Check each n-gram for sufficient repetitions
      for (const [, positions] of ngramPositions) {
        // Apply distance filtering if enabled
        const groups = this._groupByDistance(positions, n, wordTokens.length);

        for (const group of groups) {
          if (group.length >= this.occurrenceThreshold) {
            // Mark all tokens in this group
            for (let g = 0; g < group.length; g++) {
              const pos = group[g];
              for (let w = 0; w < n; w++) {
                const idx = pos + w;
                if (!claimedIndices.has(idx)) {
                  claimedIndices.add(idx);
                  const token = wordTokens[idx];
                  const severityNum = this._severity(n, group.length, g);
                  highlightRanges.push({
                    start: token.start,
                    end: token.end,
                    severity: `level-${severityNum}`
                  });
                }
              }
            }
          }
        }
      }
    }

    // Sort by position for correct rendering order
    highlightRanges.sort((a, b) => a.start - b.start);
    return highlightRanges;
  }

  /**
   * Group positions by distance.
   * When maxDistance=0 (unlimited), all positions form one group.
   * Otherwise, positions are clustered so that consecutive positions in the
   * group are within maxDistance words of each other.
   */
  _groupByDistance(positions, ngramLen, totalTokens) {
    if (positions.length < 2) return [];

    if (this.maxDistance <= 0) {
      // No distance limit — everything is one group
      return [positions];
    }

    // positions are already in ascending order (built by the left-to-right scan)
    const groups = [];
    let currentGroup = [positions[0]];

    for (let i = 1; i < positions.length; i++) {
      // Distance = gap in word-tokens between end of previous occurrence and start of this one
      const prevEnd = positions[i - 1] + ngramLen;
      const gap = positions[i] - prevEnd;

      if (gap <= this.maxDistance) {
        currentGroup.push(positions[i]);
      } else {
        groups.push(currentGroup);
        currentGroup = [positions[i]];
      }
    }
    groups.push(currentGroup);

    return groups;
  }

  /**
   * Calculate severity level (1-6) from n-gram length, total occurrences, and
   * which occurrence this is (0-indexed).
   *
   * Short phrases repeated twice → level 1-2 (yellow/gold)
   * Longer phrases or more repeats → level 3-4 (orange)
   * Catastrophic loops → level 5-6 (red)
   */
  _severity(ngramLen, totalOccurrences, occurrenceIndex) {
    // Base from phrase length: 3-4 words → 1, 5-6 → 2, 7-8 → 3, etc.
    const lengthBase = Math.max(1, Math.ceil((ngramLen - 2) / 2));
    // Bonus from repetition count beyond the minimum
    const repeatBonus = Math.max(0, totalOccurrences - 2);
    // Later occurrences get slightly higher severity
    const positionBonus = Math.min(2, occurrenceIndex);

    return Math.min(6, lengthBase + repeatBonus + positionBonus);
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
   * Produces HTML from plain text — used during streaming only.
   */
  renderWithHighlights(text, highlightRanges) {
    if (!highlightRanges || highlightRanges.length === 0) {
      return null;
    }

    const sorted = [...highlightRanges].sort((a, b) => a.start - b.start);

    let html = '';
    let cursor = 0;

    for (const range of sorted) {
      if (range.start > cursor) {
        html += escapeHtml(text.slice(cursor, range.start));
      }

      const cls = `slop-${range.severity}`;
      html += `<span class="${cls}">${escapeHtml(text.slice(range.start, range.end))}</span>`;
      cursor = range.end;
    }

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
