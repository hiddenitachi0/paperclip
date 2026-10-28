import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CompositionError,
  assertCompositionLength,
  compositionLengthSeconds,
  findRemoteReferences,
  normalizeCompositionPath,
  prepareCompositionFiles,
  rewriteVendoredScripts,
  validateComposition,
} from "../src/composition.mjs";

const b64 = (text) => Buffer.from(text, "utf8").toString("base64");
const file = (path, text = "x") => ({ path, contentBase64: b64(text) });

describe("normalizeCompositionPath", () => {
  it("accepts plain relative paths", () => {
    assert.equal(normalizeCompositionPath("index.html"), "index.html");
    assert.equal(normalizeCompositionPath("assets/logo-2.png"), "assets/logo-2.png");
  });

  for (const bad of ["/etc/passwd", "../x.html", "a/../b.html", "a/./b.html", ".hidden.css", "a\\b.html", "a//b.html", "a/b c.html", "x\0.html", ""]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      assert.throws(() => normalizeCompositionPath(bad), CompositionError);
    });
  }

  it("refuses file types the renderer does not take", () => {
    assert.throws(() => normalizeCompositionPath("run.sh"), /type the renderer does not take/);
    assert.throws(() => normalizeCompositionPath("Makefile"), /no extension/);
  });

  it("refuses very deep paths", () => {
    assert.throws(() => normalizeCompositionPath("a/b/c/d/e/f/g/h/i.html"), /too many folders/);
  });
});

describe("validateComposition", () => {
  it("decodes the files and defaults the entry to index.html", () => {
    const { entry, files } = validateComposition({ files: [file("index.html", "<html></html>"), file("assets/a.png", "png")] });
    assert.equal(entry, "index.html");
    assert.equal(files.length, 2);
    assert.equal(files[0].bytes.toString("utf8"), "<html></html>");
    assert.equal(files[0].text, true);
    assert.equal(files[1].text, false);
  });

  it("needs the entry file among the files", () => {
    assert.throws(() => validateComposition({ entry: "main.html", files: [file("index.html")] }), /entry file "main.html"/);
  });

  it("needs an .html entry", () => {
    assert.throws(() => validateComposition({ entry: "a.css", files: [file("a.css")] }), /must be an .html file/);
  });

  it("refuses duplicates, ignoring case", () => {
    assert.throws(() => validateComposition({ files: [file("index.html"), file("INDEX.html")] }), /listed twice/);
  });

  it("refuses content that is not base64", () => {
    assert.throws(() => validateComposition({ files: [{ path: "index.html", contentBase64: "not base64!" }] }), /not valid base64/);
  });

  it("enforces the file count and the size limits", () => {
    const limits = { maxFiles: 2, maxFileBytes: 10, maxTotalBytes: 15, maxPathLength: 200, maxDepth: 8 };
    assert.throws(() => validateComposition({ files: [file("index.html"), file("a.css"), file("b.css")] }, limits), /at most 2 files/);
    assert.throws(() => validateComposition({ files: [file("index.html", "x".repeat(11))] }, limits), /larger than 10 bytes/);
    assert.throws(() => validateComposition({ files: [file("index.html", "x".repeat(9)), file("a.css", "y".repeat(9))] }, limits), /larger than 15 bytes in total/);
  });
});

describe("findRemoteReferences", () => {
  it("finds absolute addresses in HTML, CSS and JavaScript", () => {
    const html = `<img src="https://example.com/a.png"><link href='http://evil.test/x.css'><script>fetch("wss://x.test/s")</script>`;
    assert.deepEqual(findRemoteReferences(html).sort(), ["http://evil.test/x.css", "https://example.com/a.png", "wss://x.test/s"]);
  });

  it("finds protocol-relative addresses where a browser loads them", () => {
    const text = `<script src="//cdn.test/lib.js"></script><style>body{background:url(//img.test/b.png)} @import "//fonts.test/f.css";</style>`;
    assert.deepEqual(findRemoteReferences(text).sort(), ["//cdn.test/lib.js", "//fonts.test/f.css", "//img.test/b.png"]);
  });

  it("ignores XML namespaces and JavaScript comments", () => {
    const text = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"></svg><script>// just a comment\nconst a = 1; // another</script>`;
    assert.deepEqual(findRemoteReferences(text), []);
  });
});

describe("vendored libraries", () => {
  const gsapTag = `<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>`;

  it("rewrites GSAP's CDN address only when the image carries it", () => {
    const yes = rewriteVendoredScripts(gsapTag, (rel) => rel === "gsap/gsap.min.js");
    assert.equal(yes.text, `<script src="_paperclip_vendor/gsap/gsap.min.js"></script>`);
    assert.deepEqual(yes.used, ["gsap/gsap.min.js"]);
    const no = rewriteVendoredScripts(gsapTag, () => false);
    assert.equal(no.text, gsapTag);
    assert.deepEqual(no.used, []);
  });

  it("prepareCompositionFiles refuses a composition that still names the internet", () => {
    const files = validateComposition({ files: [file("index.html", gsapTag)] }).files;
    assert.throws(() => prepareCompositionFiles(files, () => false), (error) => {
      assert.ok(error instanceof CompositionError);
      assert.equal(error.code, "remote_urls");
      assert.match(error.message, /cdn\.jsdelivr\.net/);
      return true;
    });
    const ok = prepareCompositionFiles(files, () => true);
    assert.deepEqual(ok.vendor, ["gsap/gsap.min.js"]);
    assert.match(ok.files[0].bytes.toString("utf8"), /_paperclip_vendor\/gsap\/gsap\.min\.js/);
  });

  it("leaves binary files alone", () => {
    const files = validateComposition({ files: [file("index.html", "<html></html>"), file("a.png", "https://example.com in a png")] }).files;
    const out = prepareCompositionFiles(files);
    assert.equal(out.files.length, 2);
  });
});

describe("compositionLengthSeconds (D7: the length a job is held to before it renders)", () => {
  it("reads the root composition's data-duration", () => {
    const html = '<div id="root" data-composition-id="main" data-start="0" data-duration="20" data-width="1920"></div>';
    assert.equal(compositionLengthSeconds(html), 20);
  });

  it("takes the latest end of any timed element, in either quote style or none", () => {
    const html = [
      '<div id="root" data-composition-id="main" data-duration="10">',
      "<div class='clip' data-start='4' data-duration='12.5'></div>",
      "<p class=clip data-start=2 data-duration=3 title=\"a > b\"></p>",
      "</div>",
    ].join("");
    assert.equal(compositionLengthSeconds(html), 16.5);
  });

  it("ignores comments, non-numeric values and attributes that only look alike", () => {
    const html = [
      "<!-- <div data-duration=\"900\"></div> -->",
      '<div data-composition-id="main" data-duration="8" data-duration-note="999"></div>',
      '<div class="clip" data-start="intro" data-duration="5"></div>',
      '<div class="clip" data-start="1" data-duration="${len}"></div>',
    ].join("");
    assert.equal(compositionLengthSeconds(html), 8);
  });

  it("is null when the composition names no length", () => {
    assert.equal(compositionLengthSeconds("<html><body>hi</body></html>"), null);
  });

  it("assertCompositionLength refuses a composition longer than the job may be, before anything runs", () => {
    const files = [{ path: "index.html", bytes: Buffer.from('<div data-composition-id="main" data-duration="600"></div>') }];
    assert.throws(
      () => assertCompositionLength("index.html", files, 1),
      (error) => error instanceof CompositionError && error.code === "too_long" && /600 seconds/.test(error.message),
    );
    assert.equal(assertCompositionLength("index.html", files, 600), 600);
    // Half a second of encoder slack, the same as the check after a render.
    assert.equal(assertCompositionLength("index.html", files, 599.5), 600);
  });
});
