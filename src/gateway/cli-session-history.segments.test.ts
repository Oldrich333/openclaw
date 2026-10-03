import fs from "node:fs/promises";
import { expect, it } from "vitest";
import {
  readChatHistoryCliSessionImportSnapshot,
  resolveChatHistoryWithCliSessionImports,
} from "./cli-session-history.js";
import { boundEntry, user, withClaudeProjectsDir } from "./cli-session-history.test-support.js";
import { requireGatewayRecord } from "./test-helpers.assertions.js";

it("keeps canonical CLI pre-tool text once after its native binding is replaced", async () => {
  await withClaudeProjectsDir(async ({ homeDir, sessionId, filePath }) => {
    const at = Date.parse("2026-03-26T16:30:00.000Z");
    const preTool = "The answer is here.";
    const final = "Final answer.";
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
            message: { role: "assistant", content: [{ type: "text", text: row.text }] },
          }),
        )
        .join("\n")}`,
    );
    const localMessages = [
      user("Explain, then check a tool", at - 1_000),
      { role: "assistant", content: [{ type: "text", text: preTool }], timestamp: at },
      { role: "assistant", content: [{ type: "text", text: final }], timestamp: at + 10 * 60_000 },
    ];
    const read = async (nativeSessionId: string) => {
      const params = {
        entry: boundEntry(nativeSessionId),
        provider: "claude-cli",
        localMessages,
        homeDir,
      };
      return resolveChatHistoryWithCliSessionImports({
        ...params,
        preparedImportedMessages: await readChatHistoryCliSessionImportSnapshot(params),
      });
    };
    for (const nativeSessionId of [sessionId, "replacement-session"]) {
      const history = await read(nativeSessionId);
      const texts = history.messages.map((message) =>
        JSON.stringify(requireGatewayRecord(message, "message").content),
      );
      expect(texts.filter((text) => text.includes(preTool))).toHaveLength(1);
      expect(texts.filter((text) => text.includes(final))).toHaveLength(1);
    }
  });
});
