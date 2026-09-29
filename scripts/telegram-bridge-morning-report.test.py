#!/usr/bin/env python3
"""Morning reports (run: python3 scripts/telegram-bridge-morning-report.test.py).

A quick agent with a morning report writes it at its set time and Paperclip
puts it in the morning-report outbox. The bridge sends each report through the
agent's own bot (or its boss's), into allowed private chats only, once, and
acknowledges it. These tests pin that:

  - a report goes to the agent's own bot, allowed chats only, and is acknowledged;
  - a report is sent once: a lost acknowledgement is repeated without sending again;
  - nothing is acknowledged when nobody could receive it or Telegram refused;
  - an agent without a bot of its own reports through its boss's bot;
  - a report of another company in the answer is ignored;
  - a long report is split into several messages.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_morning_report", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
STRANGER = 999999
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
MAJA = "a0000000-0000-4000-8000-000000000001"
BOSS = "a0000000-0000-4000-8000-000000000002"
HELPER = "a0000000-0000-4000-8000-000000000003"
REPORT1 = "d0000000-0000-4000-8000-000000000001"
REPORT2 = "d0000000-0000-4000-8000-000000000002"

MAJA_BOT = {"token": "maja-token", "agentId": MAJA, "name": "Maja", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}
BOSS_BOT = {"token": "boss-token", "agentId": BOSS, "name": "Boss", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}

TEXT = "Good morning!\n\nWeather: Drobak 12C, light rain. Oslo 11C.\n\nHeadlines: ..."


def report(report_id=REPORT1, agent=MAJA, text=TEXT, company=COMPANY):
    return {"id": report_id, "companyId": company, "agentId": agent, "text": text,
            "createdAt": "2026-09-29T05:00:00.000Z"}


class MorningReportTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {MAJA_BOT["token"]: {"offset": 0, "chats": [OPERATOR, STRANGER]},
                               BOSS_BOT["token"]: {"offset": 0, "chats": [OPERATOR]}},
                      "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.outbox = {COMPANY: [report()]}
        self.acks = []

        def fake_cli(*parts):
            if parts[:2] == ("morning-report", "outbox"):
                return {"reports": list(self.outbox.get(parts[3], []))}
            if parts[:2] == ("morning-report", "outbox:ack"):
                self.acks.append((parts[2], parts[4], parts[6]))
                return {"id": parts[2], "status": "delivered"}
            if parts[:2] == ("agent", "list"):
                return [{"id": MAJA, "reportsTo": BOSS, "name": "Maja", "role": "general"},
                        {"id": BOSS, "reportsTo": None, "name": "Boss", "role": "ceo"},
                        {"id": HELPER, "reportsTo": BOSS, "name": "Helper", "role": "general"}]
            return None

        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", side_effect=fake_cli),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.cli, self.save = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_pass(self, bots=None):
        bridge.notify_morning_reports(self.state, bots or [MAJA_BOT, BOSS_BOT])

    def sent_texts(self):
        return [(c.args[0], c.kwargs["chat_id"], c.kwargs["text"]) for c in self.tg.call_args_list
                if c.args[1] == "sendMessage"]

    def test_the_report_goes_through_the_agents_own_bot_to_allowed_chats_and_is_acknowledged(self):
        self.run_pass()
        self.assertEqual(self.sent_texts(), [("maja-token", OPERATOR, TEXT)])
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])
        self.assertEqual(self.state["sent_morning_reports"], [REPORT1])

    def test_a_lost_acknowledgement_is_repeated_without_sending_again(self):
        self.state["sent_morning_reports"] = [REPORT1]
        self.run_pass()
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])

    def test_nothing_is_acknowledged_when_nobody_started_the_bot(self):
        self.state["bots"][MAJA_BOT["token"]]["chats"] = []
        self.run_pass([MAJA_BOT])
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [])

    def test_nothing_is_acknowledged_when_telegram_refused(self):
        self.tg.return_value = None
        self.run_pass()
        self.assertEqual(self.acks, [])
        self.assertNotIn(REPORT1, self.state.get("sent_morning_reports", []))

    def test_an_agent_without_its_own_bot_reports_through_its_boss(self):
        self.outbox[COMPANY] = [report(agent=HELPER)]
        self.run_pass()
        texts = self.sent_texts()
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0][0], "boss-token")
        self.assertIn("on behalf of Helper", texts[0][2])

    def test_a_report_of_another_company_is_ignored(self):
        self.outbox[COMPANY] = [report(company=OTHER_COMPANY), report(REPORT2)]
        self.run_pass()
        self.assertEqual(self.acks, [(REPORT2, COMPANY, "delivered")])

    def test_a_long_report_is_split(self):
        self.outbox[COMPANY] = [report(text="News line. " * 900)]
        self.run_pass()
        self.assertGreater(len(self.sent_texts()), 1)
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])


if __name__ == "__main__":
    unittest.main()
