import fs from "node:fs/promises";
import { expect, it } from "vitest";
import {
  boundEntry,
  mergeImportedChatHistoryMessages,
  readClaudeCliSessionMessagesAsync,
  user,
  withClaudeProjectsDir,
} from "./cli-session-history.test-support.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

it("keeps canonical CLI commentary once while bound and after its native binding is replaced", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
    const at = Date.parse("2026-03-26T16:30:00.000Z");
    const preTool = "The answer is here.";
    const final = "Final answer.";
    // Claude Code writes one JSONL row per content block; commentary is one text block.
    await fs.appendFile(
      filePath,
      `\n${[
        { text: preTool, uuid: "pre-tool", timestamp: at },
        { text: final, uuid: "final", timestamp: at + 10 * 60_000 },
      ]
        .map((row) =>
          JSON.stringify({
            type: "assistant",
            uuid: row.uuid,
            timestamp: new Date(row.timestamp).toISOString(),
            message: {
              id: `msg-${row.uuid}`,
              role: "assistant",
              content: [{ type: "text", text: row.text }],
            },
          }),
        )
        .join("\n")}`,
    );
    const localMessages = [
      user("Explain, then check a tool", at - 1_000),
      { role: "assistant", content: [{ type: "text", text: preTool }], timestamp: at },
      { role: "assistant", content: [{ type: "text", text: final }], timestamp: at + 10 * 60_000 },
    ];
    for (const nativeSessionId of [sessionId, "replacement-session"]) {
      const entry = boundEntry(nativeSessionId);
      const messages = mergeImportedChatHistoryMessages({
        localMessages,
        importedMessages: await readClaudeCliSessionMessagesAsync({
          cliSessionId: nativeSessionId,
          homeDir,
          localSessionId: entry.sessionId,
        }),
      });
      const texts = messages.map((message) =>
        JSON.stringify(requireGatewayRecord(message, "message").content),
      );
      expect(texts.filter((text) => text.includes(preTool))).toHaveLength(1);
      expect(texts.filter((text) => text.includes(final))).toHaveLength(1);
    }
  });
});
