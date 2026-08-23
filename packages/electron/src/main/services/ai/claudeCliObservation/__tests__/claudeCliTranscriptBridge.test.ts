/**
 * Faithful test for the proxy→transcript bridge (NIM-806, Phase 3 / B3, Slice C).
 *
 * Drives the REAL `ClaudeCodeRawParser` pipeline (via
 * `projectRawMessagesToViewMessages`, provider `claude-code-cli`) over the row our
 * bridge builds, asserting an assembled assistant turn renders as a real assistant
 * message + a tool call whose `providerToolCallId` is set (so it dedups against the
 * synthetic interactive-prompt row).
 */

import { describe, expect, it } from "vitest";
import { projectRawMessagesToViewMessages } from "@nimbalyst/runtime/ai/server/transcript/projectRawMessages";
import type { RawMessage } from "@nimbalyst/runtime/ai/server/transcript/TranscriptTransformer";
import { buildAssistantRawContent } from "../claudeCliTranscriptBridge";
import type { AssembledAssistantMessage } from "../claudeApiMessageAssembler";

function rawRow(content: string): RawMessage {
  return {
    id: 1,
    sessionId: "sess-cli-1",
    source: "claude-code",
    direction: "output",
    content,
    hidden: false,
    createdAt: new Date("2026-06-08T00:00:00.000Z"),
  } as unknown as RawMessage;
}

describe("claudeCliTranscriptBridge", () => {
  it("renders an assembled assistant turn (text + tool_use) into the rich transcript", async () => {
    const assembled: AssembledAssistantMessage = {
      id: "msg_abc",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "tool_use",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
      content: [
        { type: "text", text: "Let me check that file." },
        { type: "tool_use", id: "toolu_xyz", name: "Read", input: { file_path: "/a.ts" } },
      ],
    };

    const content = buildAssistantRawContent(assembled);
    const messages = await projectRawMessagesToViewMessages([rawRow(content)], "claude-code-cli");

    // The assistant text reaches the transcript.
    const text = JSON.stringify(messages);
    expect(text).toContain("Let me check that file.");

    // A tool call is projected with the providerToolCallId set to the block id
    // (this is what dedups against the synthetic interactive-prompt row).
    expect(text).toContain("toolu_xyz");
    expect(text).toContain("Read");
  });

  it("nests a sub-agent's tool call under its agent when the turn carries parentToolUseId", async () => {
    // The lead turn that spawns the agent. `ClaudeCodeRawParser` turns an
    // `Agent` tool_use into a subagent node keyed by its tool_use id.
    const spawn: AssembledAssistantMessage = {
      id: "msg_lead",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      content: [
        {
          type: "tool_use",
          id: "toolu_spawn",
          name: "Agent",
          input: { subagent_type: "Explore", prompt: "look around" },
        },
      ],
    };

    // A turn the sub-agent produced. On the wire this is indistinguishable from
    // the lead's; the sidecar index is what tells us whose it is.
    const inner: AssembledAssistantMessage = {
      id: "msg_agent",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      content: [
        { type: "tool_use", id: "toolu_inner", name: "Grep", input: { pattern: "needle" } },
      ],
    };

    const rows = [
      rawRow(buildAssistantRawContent(spawn)),
      rawRow(buildAssistantRawContent(inner, { parentToolUseId: "toolu_spawn" })),
    ];
    const messages = await projectRawMessagesToViewMessages(rows, "claude-code-cli");

    const subagent = messages.find((m: any) => m.type === "subagent") as any;
    expect(subagent).toBeDefined();
    expect(subagent.subagentId).toBe("toolu_spawn");
    expect(subagent.subagent?.agentType).toBe("Explore");

    // The Grep call is nested under the agent, not left at the top level. This
    // is the whole payoff: the tree already exists, it just needed the field.
    const children = subagent.subagent?.childEvents ?? [];
    expect(children.map((c: any) => c.toolCall?.toolName)).toEqual(["Grep"]);
    expect(children[0].subagentId).toBe("toolu_spawn");
    expect(children[0].toolCall?.providerToolCallId).toBe("toolu_inner");

    // Nothing about the agent's work is left loose in the parent transcript.
    const topLevelTools = messages.filter((m: any) => m.type === "tool_call");
    expect(topLevelTools).toHaveLength(0);
  });

  it("leaves a lead turn unattributed when no parentToolUseId is given", async () => {
    const lead: AssembledAssistantMessage = {
      id: "msg_lead_only",
      role: "assistant",
      model: "claude-opus-4-8",
      stopReason: "tool_use",
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      content: [
        { type: "tool_use", id: "toolu_lead", name: "Grep", input: { pattern: "needle" } },
      ],
    };

    const parsed = JSON.parse(buildAssistantRawContent(lead));
    expect(parsed.parent_tool_use_id).toBeUndefined();
  });
});
