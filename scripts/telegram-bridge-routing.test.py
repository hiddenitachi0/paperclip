#!/usr/bin/env python3
"""Which bot gets a company's approvals and questions
(run: python3 scripts/telegram-bridge-routing.test.py).

A card goes to the bot of the agent that asked for it, or to the nearest boss
with a bot. When nobody asked (a card the board filed itself) or nobody on the
way up has a bot, the bridge used to pick "the bot closest to the top of the
org chart" and, on a tie, simply the first bot in its list. On 27 Sep a newly
connected assistant with no boss tied with the CEO, came first in the list
(bots connected in the app are listed before the old file's bots), and started
receiving the company's deploy cards, Approve button included.

These tests pin the rule that replaced it: the bot chosen in Paperclip, else
the CEO's bot, else the oldest bot; that an agent's own cards still go to its
own bot or its boss's; and that questions, waiting tasks and stuck agents use
the same rule.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these against it (used to prove they fail on the code before this change).
"""
import importlib.util
import io
import json
import os
import re
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_routing", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
CEO = "a0000000-0000-4000-8000-00000000000c"
ASSISTANT = "a0000000-0000-4000-8000-00000000000a"  # the quick agent "Maja": no boss
ENGINEER = "a0000000-0000-4000-8000-00000000000e"  # reports to the CEO, no bot
LONER = "a0000000-0000-4000-8000-00000000000f"  # no boss, no bot
FORK_LEAD = "a0000000-0000-4000-8000-00000000001f"  # reports to the CEO, has a bot
CEO_TOKEN = "8100000001:AAHceoceoceoceoceoceoceoceoceoce01"
MAJA_TOKEN = "8100000002:AAHmajamajamajamajamajamajamajam02"
FORK_TOKEN = "8100000003:AAHforkforkforkforkforkforkforkfo03"
APPROVAL_ID = "9abd6c8e-4c1d-40e7-a81e-73d1481c25ef"
ISSUE_ID = "e0000000-0000-4000-8000-000000000001"
INTERACTION_ID = "f0000000-0000-4000-8000-000000000001"

ORG = [
    {"id": CEO, "name": "CEO", "role": "ceo", "reportsTo": None},
    {"id": ASSISTANT, "name": "Assistant", "role": "general", "reportsTo": None},
    {"id": ENGINEER, "name": "Engineer", "role": "engineer", "reportsTo": CEO},
    {"id": LONER, "name": "Loner", "role": "researcher", "reportsTo": None},
    {"id": FORK_LEAD, "name": "Fork Lead", "role": "cto", "reportsTo": CEO},
]


def app_bot(agent_id, token, name, created_at="2026-09-27T09:00:00.000Z", marked=False, role=None):
    """One bot as `telegram bridge-config` returns it."""
    return {"id": f"b-{agent_id[-4:]}", "agentId": agent_id, "name": name, "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": [], "token": token,
            "receivesCompanyNotices": marked, "createdAt": created_at, "agentRole": role}


def file_bot(agent_id, token, name):
    """One bot in the old root-only file."""
    return {"agentId": agent_id, "name": name, "token": token, "companyId": COMPANY}


def approval(requested_by=None, approval_id=APPROVAL_ID):
    return {"id": approval_id, "status": "pending", "type": "approve_ceo_strategy",
            "requestedByAgentId": requested_by,
            "payload": {"kind": "deploy", "title": "Ship the new dashboard"}}


class RoutingTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        self.tmp.write("[]")
        self.tmp.close()
        self.previous_config_file = bridge.CONFIG_FILE
        bridge.CONFIG_FILE = self.tmp.name
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.state = {"bots": {t: {"offset": 0, "chats": [OPERATOR]} for t in (CEO_TOKEN, MAJA_TOKEN, FORK_TOKEN)},
                      "notified": []}
        self.api_bots = []
        self.answers = {}
        self.tg = mock.patch.object(bridge, "tg", return_value={}).start()
        mock.patch.object(bridge, "cli", side_effect=self.fake_cli).start()
        mock.patch.object(bridge, "save_state").start()
        if hasattr(bridge, "LAST_NOTICE_BOT"):
            bridge.LAST_NOTICE_BOT.clear()

    def tearDown(self):
        mock.patch.stopall()
        bridge.CONFIG_FILE = self.previous_config_file
        os.unlink(self.tmp.name)

    def fake_cli(self, *parts):
        if parts[:2] == ("telegram", "bridge-config"):
            return {"bots": self.api_bots}
        if parts[:2] == ("agent", "list"):
            return self.answers.get("agents", ORG)
        if parts[:2] == ("approval", "list"):
            return self.answers.get("approvals", [])
        if parts[:2] == ("issue", "interactions:pending"):
            return self.answers.get("interactions", [])
        if parts[:2] == ("issue", "list"):
            return self.answers.get("issues", [])
        return None

    def bots(self, api_bots=(), file_bots=()):
        """The bots as the running bridge sees them: app bots first, then the
        file's — the order that exposed the old tie-break."""
        self.api_bots = list(api_bots)
        with open(self.tmp.name, "w") as f:
            json.dump(list(file_bots), f)
        return bridge.load_bots()

    def sent_to(self):
        """The bot token of every card sent."""
        return [c.args[0] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def sent_texts(self):
        return [c.kwargs["text"] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def the_27_sep_setup(self, maja_marked=False):
        """The CEO's bot in the old file, Maja's connected in the app."""
        return self.bots(
            api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", marked=maja_marked, role="general")],
            file_bots=[file_bot(CEO, CEO_TOKEN, "CEO")],
        )


class BoardFiledCardTests(RoutingTestCase):
    def test_a_board_filed_card_goes_to_the_ceo_not_to_a_new_assistant_with_no_boss(self):
        bots = self.the_27_sep_setup()
        self.assertEqual(bots[0]["token"], MAJA_TOKEN)  # the list order that caused it
        self.answers["approvals"] = [approval(requested_by=None)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_the_ceo_is_found_by_role_even_when_the_ceo_bot_is_also_in_the_app(self):
        bots = self.bots(api_bots=[
            app_bot(ASSISTANT, MAJA_TOKEN, "Maja", created_at="2026-01-01T00:00:00.000Z", role="general"),
            app_bot(CEO, CEO_TOKEN, "CEO", created_at="2026-09-27T09:00:00.000Z", role="ceo"),
        ])
        self.answers["approvals"] = [approval(requested_by=None)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_the_bot_chosen_in_paperclip_wins(self):
        bots = self.the_27_sep_setup(maja_marked=True)
        self.answers["approvals"] = [approval(requested_by=None)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [MAJA_TOKEN])

    def test_a_bot_in_the_old_file_cannot_be_the_chosen_one(self):
        # A stray field in the old file must not make a file bot the notice bot.
        bots = self.bots(
            api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", role="general")],
            file_bots=[dict(file_bot(LONER, FORK_TOKEN, "Loner"), receivesCompanyNotices=True),
                       file_bot(CEO, CEO_TOKEN, "CEO")],
        )
        self.answers["approvals"] = [approval(requested_by=None)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_without_a_choice_or_a_ceo_the_oldest_bot_gets_it_whatever_the_list_order(self):
        org_without_ceo_bot = [dict(a, role="general") if a["id"] == CEO else a for a in ORG]
        self.answers["agents"] = org_without_ceo_bot
        self.answers["approvals"] = [approval(requested_by=None)]
        newer = app_bot(ASSISTANT, MAJA_TOKEN, "Maja", created_at="2026-09-27T09:00:00.000Z")
        older = app_bot(LONER, FORK_TOKEN, "Loner", created_at="2026-09-01T09:00:00.000Z")

        bridge.notify_approvals(self.state, self.bots(api_bots=[newer, older]))
        self.assertEqual(self.sent_to(), [FORK_TOKEN])

        self.tg.reset_mock()
        self.state["notified"] = []
        bridge.notify_approvals(self.state, self.bots(api_bots=[older, newer]))
        self.assertEqual(self.sent_to(), [FORK_TOKEN])

    def test_a_file_bot_counts_as_older_than_any_app_bot(self):
        org_without_ceo_bot = [dict(a, role="general") if a["id"] == CEO else a for a in ORG]
        self.answers["agents"] = org_without_ceo_bot
        self.answers["approvals"] = [approval(requested_by=None)]
        bots = self.bots(
            api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", created_at="2020-01-01T00:00:00.000Z")],
            file_bots=[file_bot(CEO, CEO_TOKEN, "Old file bot")],
        )

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_an_agent_with_no_bot_anywhere_above_it_reaches_the_same_bot(self):
        bots = self.the_27_sep_setup()
        self.answers["approvals"] = [approval(requested_by=LONER)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])
        self.assertIn("(on behalf of Loner)", self.sent_texts()[0])


class RequesterWalkTests(RoutingTestCase):
    """An agent's own cards still go to its own bot, or its boss's — the choice
    only decides where cards go that no agent's bot should get."""

    def test_an_agents_own_card_goes_to_its_own_bot_even_when_another_bot_is_chosen(self):
        bots = self.bots(
            api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", marked=True),
                      app_bot(FORK_LEAD, FORK_TOKEN, "Fork Lead")],
            file_bots=[file_bot(CEO, CEO_TOKEN, "CEO")],
        )
        self.answers["approvals"] = [approval(requested_by=FORK_LEAD)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [FORK_TOKEN])
        self.assertNotIn("on behalf of", self.sent_texts()[0])

    def test_a_card_from_an_agent_without_a_bot_goes_to_its_boss_even_when_another_bot_is_chosen(self):
        bots = self.the_27_sep_setup(maja_marked=True)
        self.answers["approvals"] = [approval(requested_by=ENGINEER)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])
        self.assertIn("(on behalf of Engineer)", self.sent_texts()[0])

    def test_the_assistants_own_card_goes_to_the_assistant(self):
        bots = self.the_27_sep_setup()
        self.answers["approvals"] = [approval(requested_by=ASSISTANT)]

        bridge.notify_approvals(self.state, bots)

        self.assertEqual(self.sent_to(), [MAJA_TOKEN])


class SameRuleEverywhereTests(RoutingTestCase):
    def test_a_question_nobody_on_the_way_up_has_a_bot_for_goes_to_the_ceo(self):
        bots = self.the_27_sep_setup()
        self.answers["interactions"] = [{
            "id": INTERACTION_ID, "issueId": ISSUE_ID, "issueIdentifier": "DUR-9", "issueTitle": "Release",
            "kind": "request_confirmation", "createdByAgentId": None, "title": "Ship it?", "payload": {},
        }]

        bridge.notify_interactions(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_a_waiting_task_with_no_owner_goes_to_the_ceo(self):
        bots = self.the_27_sep_setup()
        self.answers["issues"] = [{"id": ISSUE_ID, "identifier": "DUR-9", "title": "Release",
                                   "status": "blocked", "assigneeAgentId": None}]

        bridge.notify_waiting(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_a_stuck_agent_with_no_bot_above_it_goes_to_the_ceo(self):
        bots = self.the_27_sep_setup()
        self.answers["agents"] = [dict(a, status="error", errorAlertedAt="2026-09-27T10:00:00.000Z",
                                       errorAt="2026-09-27T09:00:00.000Z") if a["id"] == LONER else a
                                  for a in ORG]

        bridge.notify_stalled_agents(self.state, bots)

        self.assertEqual(self.sent_to(), [CEO_TOKEN])

    def test_the_chosen_bot_gets_questions_and_waiting_tasks_too(self):
        bots = self.the_27_sep_setup(maja_marked=True)
        self.answers["interactions"] = [{
            "id": INTERACTION_ID, "issueId": ISSUE_ID, "issueIdentifier": "DUR-9", "issueTitle": "Release",
            "kind": "request_confirmation", "createdByAgentId": None, "title": "Ship it?", "payload": {},
        }]
        self.answers["issues"] = [{"id": ISSUE_ID, "identifier": "DUR-9", "title": "Release",
                                   "status": "blocked", "assigneeAgentId": None}]

        bridge.notify_interactions(self.state, bots)
        bridge.notify_waiting(self.state, bots)

        self.assertEqual(self.sent_to(), [MAJA_TOKEN, MAJA_TOKEN])


class ConfigFieldTests(RoutingTestCase):
    def test_the_bridge_keeps_the_choice_the_date_and_the_role_from_paperclip(self):
        bots = self.bots(api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", marked=True, role="general",
                                           created_at="2026-09-27T09:00:00.000Z")])

        self.assertIs(bots[0]["receivesCompanyNotices"], True)
        self.assertEqual(bots[0]["createdAt"], "2026-09-27T09:00:00.000Z")
        self.assertEqual(bots[0]["agentRole"], "general")

    def test_only_a_real_true_counts_as_chosen(self):
        bots = self.bots(api_bots=[app_bot(ASSISTANT, MAJA_TOKEN, "Maja", marked="yes")])

        self.assertIs(bots[0]["receivesCompanyNotices"], False)

    def test_the_log_says_once_which_bot_gets_the_company_cards_and_why(self):
        bots = self.the_27_sep_setup()
        out = io.StringIO()
        with redirect_stdout(out):
            bridge.notify_approvals(self.state, bots)
            bridge.notify_approvals(self.state, bots)
        lines = [line for line in out.getvalue().splitlines() if "approvals and questions" in line]
        self.assertEqual(lines, [
            f"telegram-bridge: company {COMPANY[:8]}: approvals and questions with no bot of their own "
            "go to CEO (the CEO's bot)",
        ])


class SharedContractTests(unittest.TestCase):
    """The bridge, the CLI and the server must agree on names nothing else
    enforces."""

    def read(self, *path):
        with open(os.path.join(REPO, *path)) as f:
            return f.read()

    def test_the_server_sends_the_fields_the_bridge_chooses_by(self):
        types_src = self.read("packages", "shared", "src", "types", "telegram-bot.ts")
        block = re.search(r"export type TelegramBridgeBot = \{(.*?)\};", types_src, re.S).group(1)
        for field in ("receivesCompanyNotices", "createdAt", "agentRole"):
            self.assertIn(field, block)
        routes_src = self.read("server", "src", "routes", "telegram-bots.ts")
        roster = routes_src.split('"/instance/telegram-bridge-config"')[1][:2500]
        for field in ("receivesCompanyNotices:", "createdAt:", "agentRole:"):
            self.assertIn(field, roster)

    def test_the_cli_passes_every_roster_field_through(self):
        cli_src = self.read("cli", "src", "commands", "client", "telegram.ts")
        self.assertIn("bots.push({ ...bot, token: resolved.token })", cli_src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
