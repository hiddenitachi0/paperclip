#!/usr/bin/env python3
"""Telegram button data stays under Telegram's 64-byte limit
(run: python3 scripts/telegram-bridge-buttons.test.py).

On 2 Oct a plain confirmation card ("Can this go in the next deploy batch?",
DUR-4310) was refused by Telegram 168 times: its Approve/Decline buttons
carried "iaccept:<issue uuid>:<interaction uuid>" (81 bytes) and Telegram
rejects any button whose callback_data is over 64 bytes, so the whole message
failed and the bridge retried it every poll. The buttons now carry the short
issue reference, a message is delivered without buttons rather than not at
all, and the old long form still works for messages already sent.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_buttons", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
CEO = "a0000000-0000-4000-8000-00000000000c"
TOKEN = "8100000001:AAHceoceoceoceoceoceoceoceoceoce01"
ISSUE_ID = "e0000000-0000-4000-8000-000000000001"
INTERACTION_ID = "37882c99-1111-4222-8333-444444444444"


class ButtonsTest(unittest.TestCase):
    def setUp(self):
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.state = {"bots": {TOKEN: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        self.calls = []
        mock.patch.object(bridge, "save_state").start()
        if hasattr(bridge, "LAST_NOTICE_BOT"):
            bridge.LAST_NOTICE_BOT.clear()

    def tearDown(self):
        mock.patch.stopall()

    def bots(self):
        bot = {"agentId": CEO, "name": "CEO", "token": TOKEN, "companyId": COMPANY,
               "uiBase": "https://paperclip.example", "allowedUserIds": [], "receivesCompanyNotices": True,
               "createdAt": "2026-09-27T09:00:00.000Z", "agentRole": "ceo"}
        return [bot]

    def fake_cli(self, *parts):
        self.calls.append(parts)
        if parts[:2] == ("agent", "list"):
            return [{"id": CEO, "name": "CEO", "role": "ceo", "reportsTo": None}]
        if parts[:2] == ("issue", "interactions:pending"):
            return [{"id": INTERACTION_ID, "issueId": ISSUE_ID, "issueIdentifier": "DUR-4310",
                     "issueTitle": "Answer cards", "kind": "request_confirmation", "createdByAgentId": None,
                     "payload": {"prompt": "Can this go in the next deploy batch?"}}]
        return {}

    def test_confirmation_buttons_fit_telegram_limit(self):
        sent = []

        def fake_tg(token, method, **params):
            if method == "sendMessage":
                sent.append(params)
                for row in (params.get("reply_markup") or {}).get("inline_keyboard", []):
                    for button in row:
                        if len(button["callback_data"].encode()) > 64:
                            return None  # what Telegram does: 400
            return {}

        mock.patch.object(bridge, "cli", side_effect=self.fake_cli).start()
        mock.patch.object(bridge, "load_bots", return_value=self.bots()).start()
        mock.patch.object(bridge, "tg", side_effect=fake_tg).start()
        bridge.notify_interactions(self.state, self.bots())

        self.assertEqual(len(sent), 1, "delivered on the first try")
        buttons = sent[0]["reply_markup"]["inline_keyboard"][0]
        self.assertEqual(buttons[0]["callback_data"], f"ia:DUR-4310:{INTERACTION_ID}")
        self.assertEqual(buttons[1]["callback_data"], f"ir:DUR-4310:{INTERACTION_ID}")
        for button in buttons:
            self.assertLessEqual(len(button["callback_data"].encode()), 64)

    def test_message_still_delivered_when_buttons_are_refused(self):
        sent = []

        def fake_tg(token, method, **params):
            if method == "sendMessage":
                sent.append(params)
                return None if "reply_markup" in params else {"message_id": 1}
            return {}

        mock.patch.object(bridge, "cli", side_effect=self.fake_cli).start()
        mock.patch.object(bridge, "tg", side_effect=fake_tg).start()
        bridge.notify_interactions(self.state, self.bots())

        self.assertNotIn("reply_markup", sent[-1], "last attempt goes out without buttons")
        self.assertIn("Open in Paperclip", sent[-1]["text"])

    def tap(self, data):
        mock.patch.object(bridge, "cli", side_effect=self.fake_cli).start()
        mock.patch.object(bridge, "tg", return_value={}).start()
        bridge.handle_callback({"id": "cb1", "data": data, "_token": TOKEN, "_allowed": {OPERATOR},
                                "from": {"id": OPERATOR}, "message": {}})
        return [c for c in self.calls if c[:1] == ("issue",)]

    def test_short_buttons_accept_and_decline(self):
        self.assertEqual(self.tap(f"ia:DUR-4310:{INTERACTION_ID}"),
                         [("issue", "interaction:accept", "DUR-4310", INTERACTION_ID)])
        self.calls.clear()
        mock.patch.stopall()
        mock.patch.object(bridge, "save_state").start()
        self.assertEqual(self.tap(f"ir:DUR-4310:{INTERACTION_ID}"),
                         [("issue", "interaction:reject", "DUR-4310", INTERACTION_ID)])

    def test_old_long_buttons_still_work(self):
        self.assertEqual(self.tap(f"iaccept:{ISSUE_ID}:{INTERACTION_ID}"),
                         [("issue", "interaction:accept", ISSUE_ID, INTERACTION_ID)])


if __name__ == "__main__":
    unittest.main()
