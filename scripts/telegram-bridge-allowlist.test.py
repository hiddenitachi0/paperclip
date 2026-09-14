#!/usr/bin/env python3
"""Who may use the Telegram bots (run: python3 scripts/telegram-bridge-allowlist.test.py).

Until this check existed, anyone who found a bot and wrote to it was added to
that bot's chats, received every approval card after that, and could tap
Approve — which runs with the operator's board rights. These tests pin that a
stranger gets nothing and can do nothing, and that the operator's existing
chat keeps working without any setup.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("telegram_bridge", os.path.join(HERE, "telegram-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
STRANGER = 999999
BOT = {"token": "bot-token", "agentId": "agent-1", "name": "CEO", "companyId": "company-1", "uiBase": "https://x"}


def message(user_id, text="hello", chat_type="private", chat_id=None):
    return {
        "chat": {"id": chat_id if chat_id is not None else user_id, "type": chat_type},
        "from": {"id": user_id},
        "text": text,
    }


class BridgeTestCase(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli", return_value={"ok": True}),
            mock.patch.object(bridge, "cli_env", return_value={"identifier": "DUR-1"}),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.cli, self.cli_env, _ = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()


class StrangerTests(BridgeTestCase):
    def test_a_stranger_writing_to_the_bot_is_not_added_and_creates_no_task(self):
        bridge.handle_message(self.state, BOT, message(STRANGER, "deploy everything"))

        self.assertEqual(self.state["bots"][BOT["token"]]["chats"], [OPERATOR])
        self.cli_env.assert_not_called()
        self.cli.assert_not_called()

    def test_a_stranger_cannot_ask_for_status(self):
        bridge.handle_message(self.state, BOT, message(STRANGER, "/status"))

        self.cli.assert_not_called()
        self.tg.assert_not_called()

    def test_a_stranger_tapping_approve_approves_nothing(self):
        bridge.handle_callback({"id": "cq-1", "_token": BOT["token"], "from": {"id": STRANGER},
                                "data": "approve:9abd6c8e-4c1d-40e7-a81e-73d1481c25ef",
                                "message": {"message_id": 5, "chat": {"id": STRANGER}, "text": "Deploy"}})

        self.cli.assert_not_called()

    def test_a_group_chat_is_refused_even_when_the_operator_writes_in_it(self):
        bridge.handle_message(self.state, BOT, message(OPERATOR, "hello", chat_type="group", chat_id=-100200))

        self.assertNotIn(-100200, self.state["bots"][BOT["token"]]["chats"])
        self.cli_env.assert_not_called()

    def test_cards_are_only_sent_to_allowed_private_chats(self):
        self.state["bots"][BOT["token"]]["chats"] = [OPERATOR, STRANGER, -100200]

        self.assertEqual(bridge.deliverable_chats(self.state, BOT["token"]), [OPERATOR])


class OperatorTests(BridgeTestCase):
    def test_the_operator_still_creates_a_task_by_writing_to_the_bot(self):
        bridge.handle_message(self.state, BOT, message(OPERATOR, "check the budget"))

        self.cli_env.assert_called_once()

    def test_the_operator_can_still_approve_from_telegram(self):
        bridge.handle_callback({"id": "cq-2", "_token": BOT["token"], "from": {"id": OPERATOR},
                                "data": "approve:9abd6c8e-4c1d-40e7-a81e-73d1481c25ef",
                                "message": {"message_id": 6, "chat": {"id": OPERATOR}, "text": "Deploy"}})

        self.cli.assert_called_once_with("approval", "approve", "9abd6c8e-4c1d-40e7-a81e-73d1481c25ef")


class WhoIsAllowedTests(unittest.TestCase):
    def test_without_a_setting_the_private_chats_already_connected_are_allowed(self):
        state = {"bots": {"a": {"chats": [OPERATOR, -100200]}, "b": {"chats": [OPERATOR]}}}

        allowed, source = bridge.resolve_allowed_user_ids(state, "")

        self.assertEqual(allowed, {OPERATOR})
        self.assertIn("already connected", source)

    def test_the_setting_replaces_the_connected_chats(self):
        state = {"bots": {"a": {"chats": [OPERATOR]}}}

        allowed, _ = bridge.resolve_allowed_user_ids(state, " 222, 333 ;x")

        self.assertEqual(allowed, {222, 333})

    def test_nobody_is_allowed_when_nothing_is_connected_and_nothing_is_set(self):
        allowed, _ = bridge.resolve_allowed_user_ids({"bots": {}}, "")

        self.assertEqual(allowed, set())


if __name__ == "__main__":
    unittest.main(verbosity=2)
