/**
 * DUR-4013: shared HTML shell for the fixture sites. Kept deliberately
 * script-light -- these fixtures exist to exercise the worker's tools and
 * the refusal matrix against realistic markup, not to test JS-heavy SPA
 * behaviour.
 */
export function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
</head>
<body>
${body}
</body>
</html>`;
}
