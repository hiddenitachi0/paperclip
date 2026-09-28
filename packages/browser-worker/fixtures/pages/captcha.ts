import { page } from "../layout.js";

/**
 * A bot-check wall. The fixture for the design's rule: "Captchas/bot walls
 * (never solved, no solving services) -> park + hand over". There is
 * deliberately no way to pass this page programmatically -- the "verify"
 * button always re-renders the same challenge -- so a test can assert the
 * worker's driver calls browser_hand_over instead of attempting to solve it.
 */
export function captchaPage(): string {
  return page(
    "Are you human?",
    `
    <h1>Are you human?</h1>
    <p>Select all squares with a bicycle.</p>
    <div role="group" aria-label="captcha grid">
      <button type="button" aria-label="tile 1"></button>
      <button type="button" aria-label="tile 2"></button>
      <button type="button" aria-label="tile 3"></button>
      <button type="button" aria-label="tile 4"></button>
    </div>
    <form method="get" action="/captcha">
      <button type="submit">Verify</button>
    </form>
    `,
  );
}
