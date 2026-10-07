import type { ReactNode } from "react";

/**
 * A deliberately small TS/TSX highlighter — regex tokens, one pass, four
 * categories. Not a real lexer: it's tuned to read the same as the approved
 * design's hand-authored spans, not to handle every TypeScript construct.
 * Reach for a real highlighter (shiki, prism) only if code samples outgrow it.
 */

const KEYWORDS = new Set([
  "import",
  "export",
  "from",
  "const",
  "let",
  "var",
  "async",
  "await",
  "function",
  "return",
  "type",
  "interface",
  "extends",
  "implements",
  "new",
  "throw",
  "try",
  "catch",
  "finally",
  "if",
  "else",
  "for",
  "while",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "class",
  "readonly",
  "public",
  "private",
  "protected",
  "static",
  "as",
  "satisfies",
  "in",
  "of",
  "typeof",
  "instanceof",
  "null",
  "undefined",
  "true",
  "false",
  "void",
  "never",
  "unknown",
  "any",
  "string",
  "number",
  "boolean",
  "POST",
  "GET",
]);

// Order matters: comments and strings must win over everything inside them.
const TOKEN =
  /(\/\/[^\n]*)|(`(?:\\.|\$\{[^}]*\}|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\b[A-Za-z_$][\w$]*\b)(?=\s*\()|(\b\d+(?:\.\d+)?\b)|(\b[A-Za-z_$][\w$]*\b)/g;

export function highlight(code: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of code.matchAll(TOKEN)) {
    const [full, comment, str, call, num] = match;
    const start = match.index ?? 0;

    if (start > last) out.push(code.slice(last, start));

    if (comment)
      out.push(
        <span className="c" key={key++}>
          {comment}
        </span>,
      );
    else if (str)
      out.push(
        <span className="s" key={key++}>
          {str}
        </span>,
      );
    else if (call)
      out.push(
        <span className="f" key={key++}>
          {call}
        </span>,
      );
    else if (num)
      out.push(
        <span className="n" key={key++}>
          {num}
        </span>,
      );
    else if (KEYWORDS.has(full))
      out.push(
        <span className="k" key={key++}>
          {full}
        </span>,
      );
    else out.push(full);

    last = start + full.length;
  }

  if (last < code.length) out.push(code.slice(last));
  return out;
}
