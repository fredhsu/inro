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

  it("renders Markdown math as KaTeX HTML without enabling raw Markdown HTML", () => {
    const rendered = renderRevision({
      format: "markdown",
      content: "Inline $x^2$.\n\n$$\\frac{1}{2}$$\n\n<script>alert(1)</script>",
    });

    assert.equal(rendered.mode, "inline");
    assert.match(rendered.html, /<span class="math math-inline"><span class="katex">/);
    assert.match(rendered.html, /<div class="math math-display"><span class="katex-display">/);
    assert.match(rendered.html, /<math xmlns="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
    assert.doesNotMatch(rendered.html, /&lt;span class=.katex/);
    assert.doesNotMatch(rendered.html, /href="http:\/\/www\.w3\.org\/1998\/Math\/MathML"/);
    assert.match(rendered.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(rendered.html, /<script>alert\(1\)<\/script>/);
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
