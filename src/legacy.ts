export interface QuoteAnnotationRecord {
  exact: string;
  prefix?: string;
  suffix?: string;
  note?: string;
  tags: string[];
  createdAt: number;
}

export function annotationTarget(markdown: string): string | null {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const target = frontmatter?.[1].match(/^annotation-target:\s*(.+?)\s*$/m)?.[1]?.trim();
  return target ? target.replace(/^['"]|['"]$/g, "") : null;
}

export function comparableFileName(value: string | null): string | null {
  if (!value) return null;
  let decoded = value.trim();
  try { decoded = decodeURIComponent(decoded); } catch { /* retain malformed escape sequences */ }
  decoded = decoded.replace(/^vault:\/?/i, "");
  const separator = Math.max(decoded.lastIndexOf("/"), decoded.lastIndexOf("\\"));
  return (separator >= 0 ? decoded.slice(separator + 1) : decoded).normalize("NFC").toLowerCase();
}

export function quoteAnnotations(markdown: string): QuoteAnnotationRecord[] {
  const records: QuoteAnnotationRecord[] = [];
  const lines = markdown.split(/\r?\n/);
  for (let line = 0; line < lines.length; line++) {
    if (!/^>?\s*```annotation-json\s*$/.test(lines[line])) continue;
    const json: string[] = [];
    line++;
    while (line < lines.length && !/^>?\s*```\s*$/.test(lines[line])) {
      json.push(lines[line].replace(/^>\s?/, ""));
      line++;
    }
    try {
      const value = JSON.parse(json.join("\n")) as Record<string, unknown>;
      let exact = "";
      let prefix: string | undefined;
      let suffix: string | undefined;
      for (const target of Array.isArray(value.target) ? value.target : []) {
        const selectors = target && typeof target === "object" && Array.isArray((target as { selector?: unknown[] }).selector)
          ? (target as { selector: unknown[] }).selector
          : [];
        for (const selector of selectors) {
          if (!selector || typeof selector !== "object") continue;
          const item = selector as { type?: unknown; exact?: unknown; prefix?: unknown; suffix?: unknown };
          if (item.type !== "TextQuoteSelector" || typeof item.exact !== "string") continue;
          exact = item.exact;
          if (typeof item.prefix === "string") prefix = item.prefix;
          if (typeof item.suffix === "string") suffix = item.suffix;
        }
      }
      if (!exact.trim()) continue;
      const timestamp = typeof value.created === "string" ? Date.parse(value.created) : Number.NaN;
      records.push({
        exact,
        prefix,
        suffix,
        note: typeof value.text === "string" ? value.text.trim() : undefined,
        tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
        createdAt: Number.isFinite(timestamp) ? timestamp : Date.now(),
      });
    } catch { /* malformed legacy blocks are ignored independently */ }
  }
  return records;
}
