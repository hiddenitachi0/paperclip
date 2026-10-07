"""Urgent-mail alerts go out from the mailbox's own assistant's bot (DUR-4573 follow-up).

Run: python3 scripts/telegram-bridge-mail-urgency.test.py
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_mail_urgency", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
SECRETARY = "a0000000-0000-4000-8000-000000000010"
LEAD = "a0000000-0000-4000-8000-000000000011"
ALERT1 = "b0000000-0000-4000-8000-000000000001"
ALERT2 = "b0000000-0000-4000-8000-000000000002"

SECRETARY_BOT = {"token": "secretary-token", "agentId": SECRETARY, "name": "Secretary", "companyId": COMPANY,
                 "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}
LEAD_BOT = {"token": "lead-token", "agentId": LEAD, "name": "Lead", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR},
            "source": "paperclip", "receivesCompanyNotices": True}


def alert(alert_id=ALERT1, agent_id=SECRETARY):
    return {"id": alert_id, "companyId": COMPANY, "messageId": "m1", "agentId": agent_id,
            "text": "Urgent: Sender <s@example.com>", "createdAt": "2026-10-07T21:00:00Z"}


class MailUrgencyRoutingTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {SECRETARY_BOT["token"]: {"offset": 0, "chats": [OPERATOR]},
                               LEAD_BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.outbox = [alert()]
        self.acks = []

        def fake_cli(*parts):
            if parts[:2] == ("mail-urgency", "outbox"):
                return {"alerts": list(self.outbox)}
            if parts[:2] == ("mail-urgency", "outbox:ack"):
                self.acks.append(parts[2])
                return {"id": parts[2], "status": "delivered"}
            if parts[:2] == ("agent", "list"):
                return [{"id": LEAD, "reportsTo": None, "name": "Lead", "role": "ceo"},
                        {"id": SECRETARY, "reportsTo": LEAD, "name": "Secretary", "role": "general"}]
            return None

        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", side_effect=fake_cli),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "ack_mail_urgency_alert", side_effect=lambda c, a: self.acks.append(a)),
        ]
        self.tg = self.patches[0].start()
        for p in self.patches[1:]:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def senders(self):
        return [c.args[0] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def test_alert_goes_from_the_mailbox_assistants_own_bot(self):
        bridge.notify_mail_urgency_alerts(self.state, [SECRETARY_BOT, LEAD_BOT])
        self.assertEqual(self.senders(), ["secretary-token"])
        self.assertEqual(self.acks, [ALERT1])

    def test_assistant_without_a_bot_means_the_alert_waits_never_the_company_bot(self):
        bridge.notify_mail_urgency_alerts(self.state, [LEAD_BOT])
        self.assertEqual(self.senders(), [])
        self.assertEqual(self.acks, [])

    def test_mailbox_with_no_assistant_uses_the_company_notice_bot(self):
        self.outbox = [alert(ALERT2, agent_id=None)]
        bridge.notify_mail_urgency_alerts(self.state, [SECRETARY_BOT, LEAD_BOT])
        self.assertEqual(self.senders(), ["lead-token"])
        self.assertEqual(self.acks, [ALERT2])


if __name__ == "__main__":
    unittest.main()
