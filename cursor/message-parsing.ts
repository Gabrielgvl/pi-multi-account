/**
 * Turning Pi's OpenAI-shaped message list into the turn structure Cursor wants.
 *
 * This is the module that matters whenever we cannot resume Cursor's own server-side
 * conversation and have to rebuild it from Pi's transcript — which happens on a restored
 * session, on a fresh process, and (since compaction stopped being a no-op) after every
 * compaction. Everything the model will know about the work so far has to survive this
 * function; whatever it drops is gone.
 *
 * It lives apart from proxy.ts because proxy.ts imports generated protobuf code with
 * non-erasable `enum`s, which Node's type stripping refuses to load — so nothing in proxy.ts
 * can be unit tested. This file has no such dependency and is tested directly.
 */

export interface ContentPart {
  type: string;
  text?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null | ContentPart[];
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface ParsedToolResult {
  content: string;
  isError: boolean;
}

export interface ParsedAssistantTextStep {
  kind: "assistantText";
  text: string;
}

export interface ParsedToolCallStep {
  kind: "toolCall";
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  result?: ParsedToolResult;
}

export type ParsedTurnStep = ParsedAssistantTextStep | ParsedToolCallStep;

export interface ParsedTurn {
  userText: string;
  steps: ParsedTurnStep[];
}

export interface ToolResultInfo {
  toolCallId: string;
  content: string;
}

export interface ParsedMessages {
  systemPrompt: string;
  userText: string;
  /** Completed turns, ready to be replayed as conversation history. */
  turns: ParsedTurn[];
  toolResults: ToolResultInfo[];
  /**
   * The turn that is still in flight: the user asked something, the assistant called tools,
   * and their results have just come back. On the live path those results are fed straight
   * into the open stream, so this is unused. On the rebuild path it is the only record that
   * the work happened at all — without it the model is handed the original question again
   * with no idea it already ran the tools, or a naked blob of tool output with no question
   * attached to it.
   */
  pendingTurn?: ParsedTurn;
}

export function textContent(content: OpenAIMessage["content"]): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content.filter((p) => p.type === "text" && p.text).map((p) => p.text!).join("\n");
}

export function parseToolCallArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return raw ? { __raw: raw } : {};
  }
}

export function isToolCallStep(step: ParsedTurnStep): step is ParsedToolCallStep {
  return step.kind === "toolCall";
}

function stripTurnRuntimeState(turn: ParsedTurn & {
  toolCallById?: Map<string, ParsedToolCallStep>;
  sawToolResult?: boolean;
  sawAssistantAfterToolResult?: boolean;
}): ParsedTurn {
  return { userText: turn.userText, steps: turn.steps };
}

export function parseMessages(
  messages: OpenAIMessage[],
  debug?: (event: string, data: Record<string, unknown>) => void,
): ParsedMessages {
  let systemPrompt = "You are a helpful assistant.";
  const turns: ParsedTurn[] = [];

  debug?.("parse_messages.start", { messages });

  const systemParts = messages.filter((m) => m.role === "system").map((m) => textContent(m.content));
  if (systemParts.length > 0) systemPrompt = systemParts.join("\n");

  const nonSystem = messages.filter((m) => m.role !== "system");
  let currentTurn: (ParsedTurn & {
    toolCallById: Map<string, ParsedToolCallStep>;
    sawToolResult: boolean;
    sawAssistantAfterToolResult: boolean;
  }) | null = null;

  const finalizeCurrentTurn = () => {
    if (!currentTurn) return;
    turns.push(stripTurnRuntimeState(currentTurn));
    currentTurn = null;
  };

  for (const msg of nonSystem) {
    if (msg.role === "user") {
      finalizeCurrentTurn();
      currentTurn = {
        userText: textContent(msg.content),
        steps: [],
        toolCallById: new Map(),
        sawToolResult: false,
        sawAssistantAfterToolResult: false,
      };
      continue;
    }

    if (!currentTurn) continue;

    if (msg.role === "assistant") {
      const text = textContent(msg.content);
      if (text) {
        if (currentTurn.sawToolResult) currentTurn.sawAssistantAfterToolResult = true;
        currentTurn.steps.push({ kind: "assistantText", text });
      }

      for (const toolCall of msg.tool_calls ?? []) {
        const step: ParsedToolCallStep = {
          kind: "toolCall",
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          arguments: parseToolCallArguments(toolCall.function.arguments),
        };
        currentTurn.steps.push(step);
        currentTurn.toolCallById.set(step.toolCallId, step);
      }
      continue;
    }

    if (msg.role === "tool") {
      const toolCallId = msg.tool_call_id ?? "";
      const content = textContent(msg.content);
      const existing = toolCallId ? currentTurn.toolCallById.get(toolCallId) : undefined;
      if (existing) {
        existing.result = { content, isError: false };
      } else {
        const step: ParsedToolCallStep = {
          kind: "toolCall",
          toolCallId,
          toolName: "",
          arguments: {},
          result: { content, isError: false },
        };
        currentTurn.steps.push(step);
        if (toolCallId) currentTurn.toolCallById.set(toolCallId, step);
      }
      currentTurn.sawToolResult = true;
    }
  }

  let userText = "";
  let toolResults: ToolResultInfo[] = [];
  let pendingTurn: ParsedTurn | undefined;

  if (currentTurn) {
    const toolCallSteps = currentTurn.steps.filter(isToolCallStep);
    const hasAnyToolResults = toolCallSteps.some((step) => step.result);
    const lastStep = currentTurn.steps.at(-1);
    const isToolContinuation = lastStep?.kind === "toolCall";

    if (currentTurn.steps.length === 0 || isToolContinuation) {
      userText = currentTurn.userText;
      if (hasAnyToolResults) {
        toolResults = toolCallSteps
          .filter((step) => step.result)
          .map((step) => ({ toolCallId: step.toolCallId, content: step.result!.content }));
      }
      // Keep the whole in-flight turn, not just its results. The live path ignores this;
      // the rebuild path cannot reconstruct the session without it.
      if (currentTurn.steps.length > 0) {
        pendingTurn = stripTurnRuntimeState(currentTurn);
      }
    } else {
      turns.push(stripTurnRuntimeState(currentTurn));
    }
  }

  const parsed: ParsedMessages = { systemPrompt, userText, turns, toolResults, pendingTurn };
  debug?.("parse_messages.end", parsed as unknown as Record<string, unknown>);
  return parsed;
}

/**
 * The history to replay when Cursor's own conversation cannot be resumed.
 *
 * The in-flight turn is part of the history here: by the time we rebuild, its tool calls have
 * already run and their results are known, so it is a completed turn as far as the model is
 * concerned. Leaving it out is what made a restored session — and every post-compaction
 * turn — start over with no idea what had just happened.
 */
export function historyForRebuild(parsed: Pick<ParsedMessages, "turns" | "pendingTurn">): ParsedTurn[] {
  return parsed.pendingTurn ? [...parsed.turns, parsed.pendingTurn] : [...parsed.turns];
}

/** Marker used as the request action when the in-flight turn already carries the real ask. */
export const CONTINUATION_PROMPT =
  "Continue from the tool results above. Do not repeat work that is already done.";

/**
 * What to send as the request's user message.
 *
 * Previously this was `userText || toolResults.join("\n")`, which had two failure modes and hit
 * one of them every time: with a user question present the tool results were dropped outright,
 * and without one the model got raw tool output as if the user had typed it.
 *
 * The right answer depends on who is holding the history. When we rebuild, the in-flight turn
 * (calls AND results) is replayed as history, so the action only has to say "carry on". When
 * Cursor resumes from its own checkpoint our history is ignored entirely — and that checkpoint
 * has the assistant's tool calls but not their results, because the stream died before they
 * were delivered — so the results themselves have to travel in the action.
 */
export function requestActionText(
  parsed: Pick<ParsedMessages, "userText" | "toolResults" | "pendingTurn">,
  options: { hasCheckpoint: boolean },
): string {
  if (!parsed.pendingTurn) return parsed.userText;
  if (!options.hasCheckpoint) return CONTINUATION_PROMPT;
  const results = parsed.toolResults.map((result) => result.content).join("\n").trim();
  return results ? `${CONTINUATION_PROMPT}\n\n${results}` : CONTINUATION_PROMPT;
}

/** @deprecated Use {@link requestActionText}; kept so the rebuild-only shape stays explicit. */
export function actionTextForRebuild(parsed: Pick<ParsedMessages, "userText" | "toolResults" | "pendingTurn">): string {
  return requestActionText(parsed, { hasCheckpoint: false });
}
