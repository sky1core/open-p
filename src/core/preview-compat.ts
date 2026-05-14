export function isPreviewCompatibleWithFinalText(preview: string | null, finalText: string): boolean {
  if (!preview || !finalText) {
    return false;
  }
  const normalizedPreview = normalizeComparableText(preview);
  if (!normalizedPreview) {
    return false;
  }
  const normalizedFinal = normalizeComparableText(finalText);
  const normalizedRenderedFinal = normalizeComparableText(renderMarkdownForTerminalComparison(finalText));
  return normalizedFinal.startsWith(normalizedPreview) || normalizedRenderedFinal.startsWith(normalizedPreview);
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
