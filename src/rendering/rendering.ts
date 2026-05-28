import MarkdownIt from "markdown-it";
import katex from "katex";
import type MarkdownItType from "markdown-it";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type { RevisionFormat } from "../domain/types.js";

export type RenderedRevision =
  | { mode: "inline"; html: string }
  | { mode: "iframe"; html: string; sandbox: "" };

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
}).use(markdownMath);

export function renderRevision(input: { format: RevisionFormat; content: string }): RenderedRevision {
  if (input.format === "html") {
    return { mode: "iframe", html: input.content, sandbox: "" };
  }

  return { mode: "inline", html: markdown.render(input.content) };
}

function markdownMath(md: MarkdownItType): void {
  md.block.ruler.before("paragraph", "math_block", mathBlock);
  md.inline.ruler.before("escape", "math_inline", mathInline);

  md.renderer.rules.math_block = (tokens, idx) =>
    `<div class="math math-display">${safeKatex(tokens[idx].content, true)}</div>\n`;
  md.renderer.rules.math_inline = (tokens, idx) =>
    `<span class="math math-inline">${safeKatex(tokens[idx].content, false)}</span>`;
}

function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const firstLineEnd = state.eMarks[startLine];
  const firstLine = state.src.slice(start, firstLineEnd);

  if (!firstLine.startsWith("$$")) {
    return false;
  }

  const firstLineContent = firstLine.slice(2);
  const sameLineClose = firstLineContent.indexOf("$$");
  let content = "";
  let nextLine = startLine + 1;

  if (sameLineClose >= 0) {
    content = firstLineContent.slice(0, sameLineClose);
  } else {
    const lines = [firstLineContent];
    let foundClose = false;

    for (; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineEnd);
      const close = line.indexOf("$$");

      if (close >= 0) {
        lines.push(line.slice(0, close));
        nextLine += 1;
        foundClose = true;
        break;
      }

      lines.push(line);
    }

    if (!foundClose) {
      return false;
    }

    content = lines.join("\n");
  }

  if (silent) {
    return true;
  }

  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, nextLine];
  state.line = nextLine;
  return true;
}

function mathInline(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x24 || state.src.charCodeAt(state.pos + 1) === 0x24) {
    return false;
  }

  let close = state.pos + 1;
  while (close < state.posMax) {
    if (state.src.charCodeAt(close) === 0x0a) {
      return false;
    }

    if (state.src.charCodeAt(close) === 0x24 && state.src.charCodeAt(close - 1) !== 0x5c) {
      break;
    }

    close += 1;
  }

  if (close >= state.posMax || close === state.pos + 1) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = state.src.slice(state.pos + 1, close);
    token.markup = "$";
  }

  state.pos = close + 1;
  return true;
}

function safeKatex(expression: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expression.trim(), { displayMode, throwOnError: false, strict: "ignore" });
  } catch {
    return escapeHtml(expression);
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
