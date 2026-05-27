import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderRevision } from "../src/rendering/rendering.js";

describe("Rendering", () => {
  it("renders Markdown paragraphs, fenced code blocks, and KaTeX math from canonical source", () => {
    const rendered = renderRevision({
      format: "markdown",
      content: "Hello **Inro**\n\n```ts\nconst x = 1\n```\n\nInline $x^2$ and block:\n\n$$\\frac{1}{2}$$",
    });

    assert.equal(rendered.mode, "inline");
    assert.match(rendered.html, /<p>Hello <strong>Inro<\/strong><\/p>/);
    assert.match(rendered.html, /<code class="language-ts">const x = 1\n<\/code>/);
    assert.match(rendered.html, /katex/);
    assert.match(rendered.html, /x\^2|x2/);
  });

  it("represents HTML as sandboxed iframe content and does not scan it for LaTeX delimiters", () => {
    const rendered = renderRevision({
      format: "html",
      content: "<h1>Hi</h1><math><mi>x</mi></math><p>$not-katex$</p>",
    });

    assert.equal(rendered.mode, "iframe");
    assert.equal(rendered.sandbox, "");
    assert.match(rendered.html, /<h1>Hi<\/h1>/);
    assert.match(rendered.html, /<math><mi>x<\/mi><\/math>/);
    assert.doesNotMatch(rendered.html, /class="katex/);
  });
});
