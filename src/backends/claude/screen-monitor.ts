export function isPublishableIntermediateText(text: string | null, previousText: string | null): text is string {
  if (!text || !text.trim()) {
    return false;
  }
  if (text === previousText) {
    return false;
  }
  return true;
}
