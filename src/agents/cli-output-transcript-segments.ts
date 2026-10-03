import { isRecord } from "@openclaw/normalization-core/record-coerce";

type AssistantTextSegment = { key: string; text: string; timestamp: number };

/** Hold complete native messages until a following message proves their boundary. */
export function createCliAssistantTextSegmentCapture(
  onSegment: (segment: AssistantTextSegment) => void,
) {
  let messageId: string | undefined;
  let blocks: AssistantTextSegment[] = [];
  let flushed = false;

  return {
    observe(message: Record<string, unknown>) {
      const id = typeof message.id === "string" ? message.id : undefined;
      if (!id) {
        return;
      }
      if (messageId && id !== messageId) {
        for (const block of blocks) {
          onSegment(block);
          flushed = true;
        }
      }
      messageId = id;
      const content = Array.isArray(message.content) ? message.content : [];
      blocks = content.flatMap((block, index) => {
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
          return [];
        }
        const text = block.text.trim();
        return text ? [{ key: `${id}:${index}`, text, timestamp: Date.now() }] : [];
      });
    },
    hasFlushed: () => flushed,
  };
}
