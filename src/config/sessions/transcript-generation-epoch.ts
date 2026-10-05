const TRANSCRIPT_GENERATION_EPOCH_SEPARATOR = "-";

/**
 * Rows-preserving rewrites keep the generation's epoch; destructive replacement starts a new one.
 * Current-turn read fences compare epochs, so an in-place rewrite does not strand running turns.
 */
export function readTranscriptGenerationEpoch(generation: string): string {
  const separator = generation.indexOf(TRANSCRIPT_GENERATION_EPOCH_SEPARATOR);
  return separator < 0 ? generation : generation.slice(0, separator);
}

/** Next generation for an in-place rewrite of existing rows. */
export function createRowsPreservingTranscriptGeneration(previous: string, fresh: string): string {
  return `${readTranscriptGenerationEpoch(previous)}${TRANSCRIPT_GENERATION_EPOCH_SEPARATOR}${fresh}`;
}
