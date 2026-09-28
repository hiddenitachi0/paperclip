#!/usr/bin/env python3
"""Market-watcher alerts (run: python3 scripts/telegram-bridge-watchers.test.py).

A watcher in Paperclip checks a price on a schedule (Bitcoin up 5% in 24
hours, and so on). When its rule fires, the watcher's quick agent writes the
alert and Paperclip puts it in an outbox. The bridge sends each alert through
the agent's own bot (or its boss's, like a card), with the picture when there
is one, and acknowledges it. These tests pin that:

  - an alert goes to the agent's own bot, into allowed private chats only;
  - a picture goes as a photo with the alert as its caption, fetched from
    Paperclip with the bridge's own sign-in (Telegram never gets an address);
  - an alert is sent once: remembered before it is acknowledged, and a lost
    acknowledgement is repeated without sending again;
  - nothing is acknowledged when nobody could receive it or Telegram refused,
    so the next pass tries again;
  - a picture that cannot be fetched never blocks the alert itself;
  - an alert of another company in the answer is ignored.
"""
import base64
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_watchers", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
STRANGER = 999999
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
MAJA = "a0000000-0000-4000-8000-000000000001"
BOSS = "a0000000-0000-4000-8000-000000000002"
HELPER = "a0000000-0000-4000-8000-000000000003"
ALERT1 = "e0000000-0000-4000-8000-000000000001"
ALERT2 = "e0000000-0000-4000-8000-000000000002"
FILE1 = "f0000000-0000-4000-8000-000000000001"
PNG = b"\x89PNG\r\n\x1a\nfake-png-bytes"

MAJA_BOT = {"token": "maja-token", "agentId": MAJA, "name": "Maja", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}
BOSS_BOT = {"token": "boss-token", "agentId": BOSS, "name": "Boss", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}

TEXT = "Bitcoin just jumped!\n\nBitcoin (BTC): $84,000, +5% in 24 hours (from $80,000)"


def alert(alert_id=ALERT1, agent=MAJA, text=TEXT, image=None, company=COMPANY):
    return {"id": alert_id, "companyId": company, "watcherId": "w1", "watcherName": "Bitcoin swings",
            "agentId": agent, "text": text, "imageFileId": image, "isTest": False,
            "createdAt": "2026-09-28T12:00:00.000Z"}


def picture(data=PNG, content_type="image/png"):
    return {"ok": True, "fileId": FILE1, "contentType": content_type, "byteSize": len(data),
            "contentBase64": base64.b64encode(data).decode()}


class WatcherAlertTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {MAJA_BOT["token"]: {"offset": 0, "chats": [OPERATOR, STRANGER]},
                               BOSS_BOT["token"]: {"offset": 0, "chats": [OPERATOR]}},
                      "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.outbox = {COMPANY: [alert()]}
        self.acks = []
        self.cli_calls = []
        self.picture = picture()

        def fake_cli(*parts):
            self.cli_calls.append(parts)
            if parts[:2] == ("watcher", "outbox"):
                return {"alerts": list(self.outbox.get(parts[3], []))}
            if parts[:2] == ("watcher", "outbox:ack"):
                self.acks.append((parts[2], parts[4], parts[6]))
                return {"id": parts[2], "status": "delivered"}
            if parts[:2] == ("chat", "image"):
                return self.picture
            if parts[:2] == ("agent", "list"):
                return [{"id": MAJA, "reportsTo": BOSS, "name": "Maja", "role": "general"},
                        {"id": BOSS, "reportsTo": None, "name": "Boss", "role": "ceo"},
                        {"id": HELPER, "reportsTo": BOSS, "name": "Helper", "role": "general"}]
            return None

        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 2}),
            mock.patch.object(bridge, "cli", side_effect=fake_cli),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.upload, self.cli, self.save = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_pass(self, bots=None):
        bridge.notify_watcher_alerts(self.state, bots or [MAJA_BOT, BOSS_BOT])

    def sent_texts(self):
        return [(c.args[0], c.kwargs["chat_id"], c.kwargs["text"]) for c in self.tg.call_args_list
                if c.args[1] == "sendMessage"]

    def test_the_alert_goes_through_the_agents_own_bot_to_allowed_private_chats_and_is_acknowledged(self):
        self.run_pass()
        self.assertEqual(self.sent_texts(), [("maja-token", OPERATOR, TEXT)])
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered")])
        self.assertEqual(self.state["sent_watcher_alerts"], [ALERT1])

    def test_a_picture_goes_as_a_photo_with_the_alert_as_its_caption(self):
        self.outbox[COMPANY] = [alert(image=FILE1)]
        self.run_pass()
        self.assertIn(("chat", "image", FILE1, "-C", COMPANY), self.cli_calls)
        self.assertEqual(self.upload.call_count, 1)
        call = self.upload.call_args
        self.assertEqual(call.args[:4], ("maja-token", "sendPhoto", "photo", "alert-f0000000.png"))
        self.assertEqual(call.args[5], PNG)
        self.assertEqual(call.kwargs, {"chat_id": OPERATOR, "caption": TEXT})
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered")])

    def test_a_long_alert_goes_as_text_then_the_picture(self):
        long_text = "Bitcoin! " * 200
        self.outbox[COMPANY] = [alert(image=FILE1, text=long_text)]
        self.run_pass()
        self.assertEqual(len(self.sent_texts()), 1)
        self.assertEqual(self.upload.call_args.kwargs, {"chat_id": OPERATOR})

    def test_a_picture_that_cannot_be_fetched_never_blocks_the_alert(self):
        self.outbox[COMPANY] = [alert(image=FILE1)]
        self.picture = {"ok": False, "status": 404, "error": "not found"}
        self.run_pass()
        texts = self.sent_texts()
        self.assertEqual(len(texts), 1)
        self.assertTrue(texts[0][2].startswith(TEXT))
        self.assertIn("could not be sent here", texts[0][2])
        self.upload.assert_not_called()
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered")])

    def test_an_alert_is_sent_once_even_when_the_acknowledgement_was_lost(self):
        self.run_pass()
        self.assertEqual(len(self.sent_texts()), 1)
        # Paperclip did not record the acknowledgement: the alert is still there.
        self.run_pass()
        self.assertEqual(len(self.sent_texts()), 1)
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered"), (ALERT1, COMPANY, "delivered")])

    def test_nothing_is_acknowledged_when_telegram_refused_so_the_next_pass_tries_again(self):
        self.tg.return_value = None
        self.run_pass()
        self.assertEqual(self.acks, [])
        self.assertNotIn(ALERT1, self.state.get("sent_watcher_alerts", []))
        self.tg.return_value = {"message_id": 3}
        self.run_pass()
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered")])

    def test_nothing_is_sent_or_acknowledged_while_nobody_has_started_the_bot(self):
        self.state["bots"][MAJA_BOT["token"]]["chats"] = []
        self.run_pass()
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [])

    def test_an_agent_without_a_bot_is_sent_through_its_boss_on_its_behalf(self):
        self.outbox[COMPANY] = [alert(agent=HELPER)]
        self.run_pass()
        texts = self.sent_texts()
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0][0], "boss-token")
        self.assertTrue(texts[0][2].endswith("(on behalf of Helper)"))

    def test_another_companys_alert_in_the_answer_is_ignored(self):
        self.outbox[COMPANY] = [alert(alert_id=ALERT2, company=OTHER_COMPANY), alert()]
        self.run_pass()
        self.assertEqual(self.acks, [(ALERT1, COMPANY, "delivered")])
        self.assertEqual(len(self.sent_texts()), 1)

    def test_the_outbox_is_only_asked_for_companies_that_have_a_bot(self):
        self.run_pass()
        outbox_calls = [c for c in self.cli_calls if c[:2] == ("watcher", "outbox")]
        self.assertEqual(outbox_calls, [("watcher", "outbox", "-C", COMPANY)])

    def test_paperclip_not_answering_sends_nothing(self):
        self.cli.side_effect = lambda *parts: None
        self.run_pass()
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [])

    def test_the_main_loop_runs_the_watcher_pass(self):
        with open(BRIDGE_PATH) as f:
            source = f.read()
        self.assertIn("notify_watcher_alerts(state, bots)", source.split("def main():", 1)[1])


if __name__ == "__main__":
    unittest.main()
