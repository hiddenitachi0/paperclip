"""Trading wallet alerts go out once, from the company notice bot (DUR-5087 N4).

Run: python3 scripts/telegram-bridge-trading-alerts.test.py
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_trading_alerts", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
LEAD = "a0000000-0000-4000-8000-000000000011"
OTHER = "a0000000-0000-4000-8000-000000000012"
ALERT1 = "b0000000-0000-4000-8000-000000000001"

LEAD_BOT = {"token": "lead-token", "agentId": LEAD, "name": "Lead", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR},
            "source": "paperclip", "receivesCompanyNotices": True}
OTHER_BOT = {"token": "other-token", "agentId": OTHER, "name": "Other", "companyId": COMPANY,
             "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}


def alert(alert_id=ALERT1, company=COMPANY, text="Safety stop: the trading wallet was paused."):
    return {"id": alert_id, "companyId": company, "walletId": None, "kind": "wallet_paused",
            "text": text, "createdAt": "2026-10-29T21:00:00Z"}


class TradingAlertTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {LEAD_BOT["token"]: {"offset": 0, "chats": [OPERATOR]},
                               OTHER_BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}}
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.outbox = [alert()]
        self.acks = []

        def fake_cli(*parts):
            if parts[:2] == ("trading-alerts", "outbox"):
                return {"alerts": list(self.outbox)}
            if parts[:2] == ("trading-alerts", "outbox:ack"):
                self.acks.append(parts[2])
                return {"id": parts[2], "status": "delivered"}
            if parts[:2] == ("agent", "list"):
                return [{"id": LEAD, "reportsTo": None, "name": "Lead", "role": "ceo"},
                        {"id": OTHER, "reportsTo": LEAD, "name": "Other", "role": "general"}]
            return None

        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", side_effect=fake_cli),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg = self.patches[0].start()
        for p in self.patches[1:]:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def sends(self):
        return [c for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def test_alert_goes_from_the_company_notice_bot_and_is_acknowledged(self):
        bridge.notify_trading_alerts(self.state, [OTHER_BOT, LEAD_BOT])
        self.assertEqual([c.args[0] for c in self.sends()], ["lead-token"])
        self.assertEqual(self.acks, [ALERT1])

    def test_a_lost_acknowledgement_never_double_sends(self):
        bridge.notify_trading_alerts(self.state, [LEAD_BOT])
        self.acks.clear()
        self.state["sent_trading_alerts"] = [ALERT1]
        bridge.notify_trading_alerts(self.state, [LEAD_BOT])
        self.assertEqual(len(self.sends()), 1)
        self.assertEqual(self.acks, [ALERT1])

    def test_no_chat_means_the_alert_waits_unacknowledged(self):
        self.state["bots"][LEAD_BOT["token"]]["chats"] = []
        bridge.notify_trading_alerts(self.state, [LEAD_BOT])
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.acks, [])

    def test_alert_for_another_company_is_ignored(self):
        self.outbox = [alert(company="c0000000-0000-4000-8000-000000000002")]
        bridge.notify_trading_alerts(self.state, [LEAD_BOT])
        self.assertEqual(self.sends(), [])
        self.assertEqual(self.acks, [])


if __name__ == "__main__":
    unittest.main()
