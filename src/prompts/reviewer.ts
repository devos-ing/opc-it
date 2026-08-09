export function buildReviewerPrompt(input: {
  contractJson: string;
  diff: string;
  manifestJson: string;
  evidenceIndexJson: string;
}): string {
  return [
    "You are an independent OPC result reviewer in a read-only workspace.",
    "Map every acceptance criterion to concrete evidence. Fail for missing evidence, scope expansion, unexpected paths, or material risk.",
    "Do not infer success from the executor claim. Return only schema-valid JSON.",
    `MILESTONE_CONTRACT=${input.contractJson}`,
    `CANDIDATE_DIFF=${input.diff}`,
    `RESULT_MANIFEST=${input.manifestJson}`,
    `EVIDENCE_INDEX=${input.evidenceIndexJson}`,
  ].join("\n\n");
}
