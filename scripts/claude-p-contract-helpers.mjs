export function incrementalTextReport(texts) {
  const textLengths = texts.map((text) => text.length);
  const growingPrefixPairs = [];
  const regressions = [];
  for (let index = 1; index < texts.length; index += 1) {
    const previous = texts[index - 1];
    const current = texts[index];
    const growsFromPrevious = typeof previous === 'string' &&
      typeof current === 'string' &&
      current.length > previous.length &&
      current.startsWith(previous);
    growingPrefixPairs.push(growsFromPrevious);
    if (!growsFromPrevious) {
      regressions.push({
        index,
        previousLength: typeof previous === 'string' ? previous.length : null,
        currentLength: typeof current === 'string' ? current.length : null,
        currentStartsWithPrevious: typeof previous === 'string' &&
          typeof current === 'string' &&
          current.startsWith(previous),
      });
    }
  }
  return {
    textEventCount: texts.length,
    textLengths,
    growingPrefixPairs,
    regressions,
    allTextEventsPrefixCompatible: texts.length >= 2 && growingPrefixPairs.every(Boolean),
    incremental: growingPrefixPairs.some(Boolean),
  };
}

export function previewFinalCompatibilityReport(texts, finalText) {
  const finalNormalized = normalizeComparableText(finalText);
  const finalRenderedNormalized = normalizeComparableText(renderMarkdownForTerminalComparison(finalText));
  const requiredPrefixLength = 80;
  const samples = texts.map((text) => {
    const normalized = normalizeComparableText(text);
    const checkedPrefixLength = Math.min(requiredPrefixLength, normalized.length);
    const checkedPrefix = normalized.slice(0, checkedPrefixLength);
    const finalStartsWithRawPrefix = checkedPrefixLength > 0 &&
      finalNormalized.startsWith(checkedPrefix);
    const finalRenderedStartsWithPrefix = checkedPrefixLength > 0 &&
      finalRenderedNormalized.startsWith(checkedPrefix);
    return {
      textLength: text.length,
      normalizedLength: normalized.length,
      checkedPrefixLength,
      finalStartsWithCheckedPrefix: finalStartsWithRawPrefix || finalRenderedStartsWithPrefix,
      finalStartsWithRawPrefix,
      finalRenderedStartsWithPrefix,
    };
  });
  return {
    finalLength: typeof finalText === 'string' ? finalText.length : null,
    finalNormalizedLength: finalNormalized.length,
    finalRenderedNormalizedLength: finalRenderedNormalized.length,
    requiredPrefixLength,
    samples,
    compatible: samples.some((sample) => sample.finalStartsWithCheckedPrefix) &&
      samples.some((sample) => sample.checkedPrefixLength >= requiredPrefixLength) &&
      samples.every((sample) => sample.finalStartsWithCheckedPrefix),
  };
}

function normalizeComparableText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function renderMarkdownForTerminalComparison(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)#{1,6}\s+/u, '$1')
      .replace(/(\*\*|__)(.*?)\1/gu, '$2')
      .replace(/(\*|_)(.*?)\1/gu, '$2')
      .replace(/`([^`]+)`/gu, '$1'))
    .join('\n');
}
