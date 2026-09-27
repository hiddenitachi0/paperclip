"""Tests for one bot = one thread, and each Telegram update handled once.

27 Sep: during a deploy the bridge could not read its bot list, dropped the
app bots, and re-added them a few seconds later while the old thread was still
waiting on Telegram. Two threads then served one bot and every message was
answered twice.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these against it.
"""

import importlib.util
import os
import threading
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_threads", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

COMPANY = "7600f03c-c836-4326-8d48-c801813c3a87"
APP_BOT = {"agentId": "621d5687-657f-48fa-ac07-d03e16d43a36", "name": "Maja", "token": "111:app",
           "companyId": COMPANY, "allowedUserIds": set()}
FILE_BOT = {"agentId": "bd3ef1b9-1690-469c-be92-81f1cadd0881", "name": "CEO", "token": "222:file",
            "companyId": COMPANY, "allowedUserIds": set()}


class KeepBotsWhilePaperclipIsDown(unittest.TestCase):
    def setUp(self):
        bridge.LAST_API_BOTS = None

    def test_a_failed_read_keeps_the_bots_paperclip_last_reported(self):
        with mock.patch.object(bridge, "load_file_bots", return_value=[FILE_BOT]), \
             mock.patch.object(bridge, "fetch_bots_from_api", side_effect=[[APP_BOT], None]):
            first = bridge.load_bots()
            during_restart = bridge.load_bots()
        self.assertEqual({b["token"] for b in first}, {APP_BOT["token"], FILE_BOT["token"]})
        self.assertEqual({b["token"] for b in during_restart}, {APP_BOT["token"], FILE_BOT["token"]})

    def test_a_real_empty_answer_still_removes_the_app_bots(self):
        with mock.patch.object(bridge, "load_file_bots", return_value=[FILE_BOT]), \
             mock.patch.object(bridge, "fetch_bots_from_api", side_effect=[[APP_BOT], []]):
            bridge.load_bots()
            after_removal = bridge.load_bots()
        self.assertEqual([b["token"] for b in after_removal], [FILE_BOT["token"]])


class OneThreadPerBot(unittest.TestCase):
    def setUp(self):
        bridge.BOT_THREADS.clear()
        bridge.CURRENT_BOTS.clear()
        bridge.LAST_API_BOTS = None

    def tearDown(self):
        bridge.BOT_THREADS.clear()
        bridge.CURRENT_BOTS.clear()

    def test_a_bot_whose_thread_is_alive_does_not_get_a_second_one(self):
        started = []
        release = threading.Event()

        def fake_thread(state, token):
            started.append(token)
            release.wait(5)

        with mock.patch.object(bridge, "bot_thread", side_effect=fake_thread), \
             mock.patch.object(bridge, "load_bots", return_value=[APP_BOT]):
            bridge.refresh_bots({"bots": {}})
            bridge.refresh_bots({"bots": {}})
            bridge.refresh_bots({"bots": {}})
        release.set()
        self.assertEqual(started, [APP_BOT["token"]])

    def test_an_old_thread_that_is_no_longer_registered_stops(self):
        other = threading.Thread(target=lambda: None)
        bridge.BOT_THREADS[APP_BOT["token"]] = other
        self.assertFalse(bridge._is_registered_thread(APP_BOT["token"]))
        bridge.BOT_THREADS[APP_BOT["token"]] = threading.current_thread()
        self.assertTrue(bridge._is_registered_thread(APP_BOT["token"]))


class EachUpdateOnce(unittest.TestCase):
    def test_the_same_update_handed_to_two_threads_is_answered_once(self):
        state = {"bots": {APP_BOT["token"]: {"offset": 100, "chats": []}}, "notified": []}
        update = {"update_id": 101, "message": {"text": "hello", "chat": {"id": 1}, "from": {"id": 1}}}
        with mock.patch.object(bridge, "handle_message") as handled, \
             mock.patch.object(bridge, "save_state"):
            bridge.handle_updates(state, APP_BOT["token"], APP_BOT, [update])
            bridge.handle_updates(state, APP_BOT["token"], APP_BOT, [update])
        self.assertEqual(handled.call_count, 1)
        self.assertEqual(state["bots"][APP_BOT["token"]]["offset"], 101)

    def test_an_update_at_or_below_the_saved_offset_is_skipped(self):
        state = {"bots": {APP_BOT["token"]: {"offset": 200, "chats": []}}, "notified": []}
        with mock.patch.object(bridge, "handle_message") as handled, \
             mock.patch.object(bridge, "save_state"):
            bridge.handle_updates(state, APP_BOT["token"], APP_BOT, [
                {"update_id": 199, "message": {"text": "old"}},
                {"update_id": 200, "message": {"text": "old"}},
                {"update_id": 201, "message": {"text": "new"}},
            ])
        self.assertEqual(handled.call_count, 1)
        self.assertEqual(handled.call_args.args[2]["text"], "new")


if __name__ == "__main__":
    unittest.main()
