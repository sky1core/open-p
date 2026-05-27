export function isPreviewCompatibleWithResultText(preview: string | null, resultText: string): boolean {
  if (!preview || !resultText) {
    return false;
  }
  const normalizedPreview = normalizeComparableText(preview);
  if (!normalizedPreview) {
    return false;
  }
  const normalizedResult = normalizeComparableText(resultText);
  const normalizedRenderedResult = normalizeComparableText(renderMarkdownForTerminalComparison(resultText));
  return normalizedResult.startsWith(normalizedPreview) || normalizedRenderedResult.startsWith(normalizedPreview);
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function renderMarkdownForTerminalComparison(value: string): string {
  return value
    .split('\n')
    .map((line) => line
      .replace(/^(\s*)#{1,6}\s+/u, '$1')
      .replace(/(\*\*|__)(.*?)\1/gu, '$2')
      .replace(/(\*|_)(.*?)\1/gu, '$2')
      .replace(/`([^`]+)`/gu, '$1'))
    .join('\n');
}
