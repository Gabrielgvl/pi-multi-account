/**
 * Cursor often omits tokenDetails on tool-call turns. Estimate prompt size from
 * the OpenAI-shaped request so Pi's auto-compact / footer are not stuck at 0.
 */
export function estimatePromptTokens(messages: unknown, tools?: unknown): number {
  const parts: string[] = [];
  try {
    if (messages !== undefined) parts.push(JSON.stringify(messages));
  } catch {
    /* ignore unserializable messages */
  }
  try {
    if (tools !== undefined) parts.push(JSON.stringify(tools));
  } catch {
    /* ignore unserializable tools */
  }
  return Math.max(1, Math.ceil(parts.join("").length / 4));
}

export function resolveCursorUsage(state: {
  outputTokens: number;
  totalTokens: number;
  promptTokenEstimate?: number;
}): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const completion_tokens = Math.max(0, state.outputTokens);
  if (state.totalTokens > 0) {
    const prompt_tokens = Math.max(0, state.totalTokens - completion_tokens);
    return { prompt_tokens, completion_tokens, total_tokens: state.totalTokens };
  }
  const prompt_tokens = Math.max(0, state.promptTokenEstimate ?? 0);
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
  };
}
