/**
 * CWrite — LLM API Client
 * OpenAI-compatible chat completion with streaming support.
 */

export class LLMClient {
  constructor() {
    this.endpoint = 'http://localhost:5001/v1';
    this.apiKey = '';
    this.model = '';
    this.abortController = null;

    // Generation stats
    this.stats = {
      model: '',
      tokensGenerated: 0,
      totalTimeMs: 0,
      ttftMs: 0,
      tokensPerSec: 0,
    };
  }

  configure({ endpoint, apiKey, model }) {
    if (endpoint !== undefined) this.endpoint = endpoint.replace(/\/+$/, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
    if (model !== undefined) this.model = model;
  }

  /**
   * Stream a chat completion.
   * @param {Array} messages - [{role, content}, ...]
   * @param {Object} params - sampling parameters
   * @param {Function} onToken - called with each text chunk
   * @param {Function} onDone - called when generation completes
   * @param {Function} onError - called on error
   * @returns {Function} cancel - call to abort the stream
   */
  async stream(messages, params, { onToken, onDone, onError }) {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const body = {
      messages,
      stream: true,
      max_tokens: params.maxTokens || 2048,
    };

    // Only include params that are set (backends vary in support)
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.topP !== undefined) body.top_p = params.topP;
    if (params.topK !== undefined) body.top_k = params.topK;
    if (params.minP !== undefined) body.min_p = params.minP;
    if (params.repeatPenalty !== undefined) body.repetition_penalty = params.repeatPenalty;
    
    // Always include a model string (required by strict OpenAI proxies like LM Studio)
    body.model = this.model || "local-model";

    // Stop strings
    if (params.stopStrings) {
      const stops = params.stopStrings.split(',').map(s => s.trim()).filter(Boolean);
      if (stops.length > 0) body.stop = stops;
    }

    const headers = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    const url = `${this.endpoint}/chat/completions`;
    const startTime = performance.now();
    let firstTokenTime = null;
    let tokenCount = 0;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`API error ${response.status}: ${errText}`);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;
          if (!trimmed.startsWith('data: ')) continue;

          try {
            const json = JSON.parse(trimmed.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (delta?.content) {
              if (firstTokenTime === null) {
                firstTokenTime = performance.now();
              }
              tokenCount++;
              onToken(delta.content);
            }

            // Capture model name from response if available
            if (json.model && !this.stats.model) {
              this.stats.model = json.model;
            }
          } catch (e) {
            // Skip malformed JSON chunks
          }
        }
      }

      const endTime = performance.now();
      this.stats = {
        model: this.stats.model || this.model || 'Unknown',
        tokensGenerated: tokenCount,
        totalTimeMs: endTime - startTime,
        ttftMs: firstTokenTime ? firstTokenTime - startTime : 0,
        tokensPerSec: tokenCount > 0 ? (tokenCount / ((endTime - (firstTokenTime || startTime)) / 1000)) : 0,
      };

      onDone(this.stats);
    } catch (err) {
      if (err.name === 'AbortError') {
        const endTime = performance.now();
        this.stats = {
          model: this.stats.model || this.model || 'Unknown',
          tokensGenerated: tokenCount,
          totalTimeMs: endTime - startTime,
          ttftMs: firstTokenTime ? firstTokenTime - startTime : 0,
          tokensPerSec: tokenCount > 0 ? (tokenCount / ((endTime - (firstTokenTime || startTime)) / 1000)) : 0,
        };
        onDone(this.stats);
      } else {
        onError(err);
      }
    }
  }

  stop() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  getStats() {
    return { ...this.stats };
  }
}

export const llmClient = new LLMClient();
