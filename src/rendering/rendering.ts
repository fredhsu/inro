import MarkdownIt from "markdown-it";
import katex from "katex";
import type { RevisionFormat } from "../domain/types.js";

export type RenderedRevision =
  | { mode: "inline"; html: string }
  | { mode: "iframe"; html: string; sandbox: "" };

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
});

export function renderRevision(input: { format: RevisionFormat; content: string }): RenderedRevision {
  if (input.format === "html") {
    return { mode: "iframe", html: input.content, sandbox: "" };
  }

  return { mode: "inline", html: markdown.render(renderMarkdownMath(input.content)) };
}

function renderMarkdownMath(source: string): string {
  const withBlocks = source.replace(/\$\$([\s\S]+?)\$\$/g, (_match, expression: string) =>
    `\n\n<div class="math math-display">${safeKatex(expression, true)}</div>\n\n`,
  );
  return withBlocks.replace(/(^|[^\\])\$([^\n$]+?)\$/g, (_match, prefix: string, expression: string) =>
    `${prefix}<span class="math math-inline">${safeKatex(expression, false)}</span>`,
  );
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
