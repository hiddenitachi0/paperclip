import type { Meta, StoryObj } from "@storybook/react-vite";
import { WeeklyCheckupCard, WeeklyCheckupCardView } from "@/components/WeeklyCheckupCard";
import { storybookLatestCheckup } from "../fixtures/paperclipData";

// DUR-62 / polish round 3: the weekly check-up card as it sits on the company
// dashboard. The first card is the live component reading the Storybook
// fetch fixture for /checkups/latest; the rest pin down each state of the
// view so the wording can be reviewed without a server.

function WeeklyCheckupStories() {
  const noop = () => undefined;
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Live card (reads the /checkups/latest fixture)</h2>
        <WeeklyCheckupCard companyId="company-storybook" />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Suggestions waiting for the operator</h2>
        <WeeklyCheckupCardView latest={storybookLatestCheckup} running={false} runMessage={null} runError={null} onRun={noop} />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Already decided</h2>
        <WeeklyCheckupCardView
          latest={{ ...storybookLatestCheckup, pendingSuggestionCount: 0, suggestionsStatus: "accepted" }}
          running={false}
          runMessage={null}
          runError={null}
          onRun={noop}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Clean report</h2>
        <WeeklyCheckupCardView
          latest={{
            report: { ...storybookLatestCheckup.report!, title: "Weekly check-up for Paperclip Labs, 7 September 2026: nothing needs your attention", status: "done" },
            suggestionCount: 0,
            pendingSuggestionCount: 0,
            suggestionsStatus: "none",
          }}
          running={false}
          runMessage={null}
          runError={null}
          onRun={noop}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">No open check-up</h2>
        <WeeklyCheckupCardView
          latest={{ report: null, suggestionCount: 0, pendingSuggestionCount: 0, suggestionsStatus: "none" }}
          running={false}
          runMessage={null}
          runError={null}
          onRun={noop}
        />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground">Running, loading, and failed to load</h2>
        <WeeklyCheckupCardView latest={storybookLatestCheckup} running runMessage={null} runError={null} onRun={noop} />
        <WeeklyCheckupCardView latest={undefined} running={false} runMessage={null} runError={null} onRun={noop} />
        <WeeklyCheckupCardView
          latest={{ report: null, suggestionCount: 0, pendingSuggestionCount: 0, suggestionsStatus: "none" }}
          running={false}
          runMessage={null}
          runError="Could not load the latest check-up: request failed"
          onRun={noop}
        />
      </section>
    </div>
  );
}

const meta = {
  title: "Product/Weekly check-up card",
  component: WeeklyCheckupStories,
  parameters: {
    docs: {
      description: {
        component:
          "The dashboard's weekly check-up card (DUR-62): live against the Storybook /checkups/latest fixture, plus every state of the view for wording review.",
      },
    },
  },
} satisfies Meta<typeof WeeklyCheckupStories>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WeeklyCheckup: Story = {};
