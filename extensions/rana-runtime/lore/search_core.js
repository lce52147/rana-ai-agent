function normalizedText(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase("zh-Hant");
}

export function tokenize(value, mode = "trigram") {
  const text = normalizedText(value);
  const latin = text.match(/[a-z0-9_]+/g) || [];
  const cjkRuns = text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu) || [];
  const tokens = [...latin];
  for (const run of cjkRuns) {
    const chars = [...run];
    if (mode === "unicode61") {
      tokens.push(run, ...chars);
      continue;
    }
    tokens.push(...chars);
    for (let width = 2; width <= 3; width += 1) {
      for (let index = 0; index <= chars.length - width; index += 1) tokens.push(chars.slice(index, index + width).join(""));
    }
  }
  return tokens.filter(Boolean);
}

export function buildBm25(chunks, mode = "trigram") {
  const documents = chunks.map((chunk) => tokenize(`${chunk.metadata?.sourceTitle || ""}\n${chunk.content || ""}`, mode));
  const documentFrequency = new Map();
  let totalLength = 0;
  for (const tokens of documents) {
    totalLength += tokens.length;
    for (const token of new Set(tokens)) documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
  }
  return {
    mode,
    documents,
    documentFrequency,
    averageLength: documents.length ? totalLength / documents.length : 0,
    size: documents.length,
  };
}

export function bm25Search(query, chunks, state = buildBm25(chunks), limit = 20) {
  const queryTokens = tokenize(query, state.mode);
  const k1 = 1.2;
  const b = 0.75;
  const scores = state.documents.map((tokens, index) => {
    const frequency = new Map();
    for (const token of tokens) frequency.set(token, (frequency.get(token) || 0) + 1);
    let score = 0;
    for (const token of queryTokens) {
      const df = state.documentFrequency.get(token) || 0;
      if (!df) continue;
      const tf = frequency.get(token) || 0;
      const idf = Math.log(1 + (state.size - df + 0.5) / (df + 0.5));
      const denominator = tf + k1 * (1 - b + b * (tokens.length / Math.max(1, state.averageLength)));
      score += idf * ((tf * (k1 + 1)) / Math.max(1e-9, denominator));
    }
    return { index, score };
  });
  return scores.filter((item) => item.score > 0).sort((left, right) => right.score - left.score).slice(0, limit);
}

export function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return -1;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export function vectorSearch(queryEmbedding, embeddings, limit = 20) {
  return embeddings
    .map((embedding, index) => ({ index, score: cosineSimilarity(queryEmbedding, embedding) }))
    .filter((item) => Number.isFinite(item.score) && item.score > -1)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export function hybridFuse({ lexical = [], vector = [], exactIndexes = new Set(), limit = 12 }) {
  const byIndex = new Map();
  lexical.forEach((item, rank) => {
    const value = byIndex.get(item.index) || { index: item.index, score: 0, lexicalScore: item.score, vectorScore: null };
    value.score += 0.45 / (60 + rank + 1);
    value.lexicalScore = item.score;
    byIndex.set(item.index, value);
  });
  vector.forEach((item, rank) => {
    const value = byIndex.get(item.index) || { index: item.index, score: 0, lexicalScore: null, vectorScore: item.score };
    value.score += 0.55 / (60 + rank + 1);
    value.vectorScore = item.score;
    byIndex.set(item.index, value);
  });
  for (const index of exactIndexes) {
    const value = byIndex.get(index);
    if (!value) continue;
    value.score += 0.02;
    value.exact = true;
    byIndex.set(index, value);
  }
  return [...byIndex.values()].sort((left, right) => right.score - left.score).slice(0, limit);
}

export function sanitizeEvidenceText(value, maxLength = 1800) {
  const clean = String(value || "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/\b(?:DIRECT|SCENE|PENDING|MANUALLY_REVIEWED|MANUALLY REVIEWED|MEMORY_ANCHOR)\b/giu, "")
    .replace(/(?:[A-Z]:\\|\/)[^\s)`]+/g, "")
    .replace(/\b(?:embedding|bm25|vector|raw score|debug trace)\b/giu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength).replace(/\s+\S*$/, "")}…`;
}
