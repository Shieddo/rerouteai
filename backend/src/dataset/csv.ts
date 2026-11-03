// Minimal RFC 4180 CSV reading and writing for the railway dataset. Handles a UTF-8 BOM, quoted
// fields with embedded commas/quotes/newlines, and CRLF line endings.

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || record.length) {
    record.push(field);
    records.push(record);
  }

  const [header, ...rows] = records.filter((r) => !(r.length === 1 && r[0] === ""));
  if (!header) return [];
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

function quote(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function stringifyCsv(columns: readonly string[], rows: readonly Record<string, unknown>[]): string {
  const lines = [columns.map(quote).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => quote(row[c] === undefined || row[c] === null ? "" : String(row[c]))).join(","));
  }
  return lines.join("\n") + "\n";
}

export async function readCsv(path: string): Promise<CsvRow[]> {
  return parseCsv(await Bun.file(path).text());
}
