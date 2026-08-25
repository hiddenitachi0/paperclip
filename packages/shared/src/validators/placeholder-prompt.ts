// DUR-162: two placeholder prompts ("test", "x") reached the operator's live
// decision queue and had to be spotted and cancelled by hand. A minimum-length
// check alone would also reject genuine short prompts ("Scope?", "OK?"), so this
// blocklists known placeholder tokens by exact (normalized) match and only falls
// back to a length check for the handful of characters too short to ever be a
// real question.
const PLACEHOLDER_PROMPT_BLOCKLIST = new Set([
  "test",
  "tests",
  "testing",
  "test123",
  "x",
  "xx",
  "xxx",
  "foo",
  "bar",
  "baz",
  "foobar",
  "asdf",
  "asdfasdf",
  "asdasd",
  "qwerty",
  "qwe",
  "lorem ipsum",
  "todo",
  "tbd",
  "wip",
  "n/a",
  "na",
  "placeholder",
  "sample",
  "example",
  "dummy",
  "abc",
  "abcd",
  "1234",
  "12345",
  "www",
  "idk",
]);

const MIN_MEANINGFUL_PROMPT_LENGTH = 3;

function normalizePromptForPlaceholderCheck(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[?.!,;:'"()[\]{}]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if `raw` looks like placeholder/test content rather than a real
 * question or confirmation prompt an operator should be asked to decide.
 * Used to refuse creating operator-facing cards at the validation layer —
 * see createIssueThreadInteractionSchema in issue.ts.
 */
export function isPlaceholderPromptText(raw: string): boolean {
  const normalized = normalizePromptForPlaceholderCheck(raw);
  if (!normalized) return true;
  if (PLACEHOLDER_PROMPT_BLOCKLIST.has(normalized)) return true;
  if (normalized.length < MIN_MEANINGFUL_PROMPT_LENGTH) return true;
  return false;
}
