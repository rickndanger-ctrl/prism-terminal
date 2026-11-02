// Keep provider usage as individual snapshots. Do not sum them without proving
// whether a provider/model reports per-turn or cumulative counters.
const counts = ['promptTokenCount', 'cachedContentTokenCount', 'responseTokenCount',
  'toolUsePromptTokenCount', 'thoughtsTokenCount', 'totalTokenCount'];
const details = ['promptTokensDetails', 'cacheTokensDetails', 'responseTokensDetails', 'toolUsePromptTokensDetails'];
const modalities = new Set(['TEXT', 'IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'MODALITY_UNSPECIFIED']);
const validCount = value => Number.isInteger(value) && value >= 0 && value <= 2147483647;

export function extractGeminiProbeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result = {};
  for (const name of counts) {
    if (!Object.hasOwn(raw, name)) continue;
    if (!validCount(raw[name])) return undefined;
    result[name] = raw[name];
  }
  for (const name of details) {
    if (!Object.hasOwn(raw, name)) continue;
    if (!Array.isArray(raw[name]) || raw[name].length > 16) return undefined;
    const values = [];
    for (const item of raw[name]) {
      if (!item || !modalities.has(item.modality) || !validCount(item.tokenCount)) return undefined;
      values.push({ modality: item.modality, tokenCount: item.tokenCount });
    }
    result[name] = values;
  }
  return Object.keys(result).length ? result : undefined;
}
