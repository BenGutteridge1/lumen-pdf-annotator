export function displayPageNumber(
  pages: readonly number[],
  manualLabel: string | undefined,
  showPrintedPageNumbers: boolean,
  printedPageLabels?: readonly string[] | null,
): string {
  const manual = manualLabel?.trim();
  if (manual) return manual;

  const orderedPages = Array.from(new Set(pages)).sort((a, b) => a - b);
  if (!orderedPages.length) return "";

  if (showPrintedPageNumbers && printedPageLabels) {
    const printed = orderedPages.map(page => printedPageLabels[page - 1]?.trim() ?? "");
    if (printed.every(Boolean)) return printed.length === 1 ? printed[0] : printed.join(", ");
  }

  if (orderedPages.length === 1) return String(orderedPages[0]);
  const consecutive = orderedPages.every((page, index) => index === 0 || page === orderedPages[index - 1] + 1);
  return consecutive ? `${orderedPages[0]}–${orderedPages.at(-1)}` : orderedPages.join(", ");
}
