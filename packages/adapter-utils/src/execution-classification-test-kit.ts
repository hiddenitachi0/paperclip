// ---------------------------------------------------------------------------
// Shared conformance fixture for the DUR-258 "no error label on a run the
// CLI itself called successful" guarantee.
//
// Every adapter's execute() test suite should feed this transcript into a
// terminal event that the CLI itself marks successful, and assert the
// resulting `AdapterExecutionResult.errorCode` is null. The transcript is
// deliberately stuffed with every keyword adapters have historically
// word-searched for (429, rate limit, unauthorized, try again later,
// invalid credentials, please authenticate) so a regression that reaches
// back into scanning full stdout/stderr instead of the CLI's own error text
// fails the test immediately, on day one, for every adapter — see DUR-258.
// ---------------------------------------------------------------------------

export const ADVERSARIAL_SUCCESS_TRANSCRIPT_LINES: readonly string[] = [
  "Retrying the CI job after it hit a 429 rate limit from the upstream package registry; waiting and trying again later.",
  "Hardening our own auth middleware: requests without a token now come back unauthorized, as expected by the new test.",
  "Logged an invalid_credentials audit event while adding the credential-rotation test fixture.",
  "The mock server responds with 'please authenticate' for the 401 branch under test.",
  "Session token said not logged in in the fixture data used to test the login-required code path.",
];

export const ADVERSARIAL_SUCCESS_TRANSCRIPT: string = ADVERSARIAL_SUCCESS_TRANSCRIPT_LINES.join("\n");
