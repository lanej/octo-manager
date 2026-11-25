// SQLite publishes expanded SQL. Redact before hashing, retaining, or formatting it.
export function sqlShape(sql: string): string {
  let out = "",
    i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      out += " ";
    } else if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      out += " ";
    } else if ((ch === "x" || ch === "X") && sql[i + 1] === "'") {
      i += 2;
      while (i < sql.length && sql[i] !== "'") i++;
      i++;
      out += "?";
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const end = ch === "[" ? "]" : ch;
      i++;
      while (i < sql.length) {
        if (sql[i] === end) {
          i++;
          if (sql[i] === end && ch !== "[") {
            i++;
            continue;
          }
          break;
        }
        i++;
      }
      out += ch === "'" ? "?" : "<quoted>";
    } else if (/[A-Za-z_$]/u.test(ch)) {
      const start = i++;
      while (i < sql.length && /[A-Za-z0-9_$]/u.test(sql[i] ?? "")) i++;
      out += sql.slice(start, i);
    } else if (
      /[0-9]/u.test(ch) ||
      (ch === "." && /[0-9]/u.test(sql[i + 1] ?? ""))
    ) {
      i++;
      while (i < sql.length && /[A-Za-z0-9_.+-]/u.test(sql[i] ?? "")) i++;
      out += "?";
    } else if (/[\s(),.;=<>!+*/%|&~?:-]/u.test(ch)) {
      out += ch;
      i++;
    } else {
      // Unknown token encodings must not leak through a permissive fallback.
      return "<unrecognized SQL>";
    }
  }
  return out.replace(/\s+/gu, " ").trim();
}

export function statementKind(shape: string): "read" | "write" | "unknown" {
  if (shape.replace(/;\s*$/u, "").includes(";")) return "unknown";
  if (/^(SELECT|EXPLAIN)\b/iu.test(shape)) return "read";
  if (
    /^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|VACUUM|REINDEX)\b/iu.test(
      shape,
    )
  )
    return "write";
  if (/^PRAGMA (data_version|schema_version)\s*;?$/iu.test(shape))
    return "read";
  return "unknown";
}
