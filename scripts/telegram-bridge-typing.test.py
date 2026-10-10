#!/usr/bin/env python3
"""Telegram "typing..." indicator (DUR-4367, run: python3 scripts/telegram-bridge-typing.test.py).

Before this, the bridge sent "typing" once, then nothing else while it waited
on the slow part (Paperclip answering, or a recording being transcribed).
Telegram clears that indicator after about 5 seconds, so on a slow reply the
person watched it vanish and had no sign anyone was still working. These
tests pin that the indicator is shown immediately and kept alive (re-sent on
an interval) for as long as `ask_agent` / `handle_voice_message` are waiting,
and stops once the reply is ready, rather than running forever or never.
"""
import importlib.util
import os
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_typing", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
CONV = "d0000000-0000-4000-8000-000000000001"


def quick(response):
    return {"ok": True, "lane": "a", "result": {"conversationId": CONV, "response": response}, "taskRef": None}


class TypingIndicatorUnitTests(unittest.TestCase):
    """The context manager itself, independent of the bridge's call sites."""

    def setUp(self):
        self.patch = mock.patch.object(bridge, "tg", return_value={})
        self.tg = self.patch.start()
        self.addCleanup(self.patch.stop)

    def typing_calls(self):
        return [c for c in self.tg.call_args_list if c.args[1] == "sendChatAction"]

    def test_sends_typing_immediately_on_entry(self):
        with bridge.TypingIndicator("tok", OPERATOR):
            calls = self.typing_calls()
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0].kwargs, {"chat_id": OPERATOR, "action": "typing"})

    def test_repeats_on_an_interval_while_the_block_is_still_running(self):
        original_interval = bridge.TypingIndicator.INTERVAL_SECONDS
        bridge.TypingIndicator.INTERVAL_SECONDS = 0.05
        try:
            with bridge.TypingIndicator("tok", OPERATOR):
                time.sleep(0.22)
            # One immediately, then roughly every 0.05s for ~0.22s: several more.
            self.assertGreaterEqual(len(self.typing_calls()), 3)
        finally:
            bridge.TypingIndicator.INTERVAL_SECONDS = original_interval

    def test_stops_sending_once_the_block_exits(self):
        original_interval = bridge.TypingIndicator.INTERVAL_SECONDS
        bridge.TypingIndicator.INTERVAL_SECONDS = 0.05
        try:
            with bridge.TypingIndicator("tok", OPERATOR):
                time.sleep(0.12)
            count_at_exit = len(self.typing_calls())
            time.sleep(0.2)
            self.assertEqual(len(self.typing_calls()), count_at_exit)
        finally:
            bridge.TypingIndicator.INTERVAL_SECONDS = original_interval

    def test_a_record_voice_action_is_used_when_asked_for(self):
        with bridge.TypingIndicator("tok", OPERATOR, action="record_voice"):
            pass
        self.assertEqual(self.typing_calls()[0].kwargs["action"], "record_voice")


class AskAgentTypingTests(unittest.TestCase):
    """The indicator actually wraps the wait inside ask_agent."""

    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli_env", return_value=quick("Hi")),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-10-02T12:00:00Z"),
        ]
        self.tg, self.cli_env, _, self.ready, self.started_at = [p.start() for p in self.patches]
        self.original_interval = bridge.TypingIndicator.INTERVAL_SECONDS

    def tearDown(self):
        bridge.TypingIndicator.INTERVAL_SECONDS = self.original_interval
        for p in self.patches:
            p.stop()

    def typing_calls(self):
        return [c for c in self.tg.call_args_list if c.args[1] == "sendChatAction"]

    def test_typing_is_sent_before_the_slow_call_and_kept_alive_until_the_reply(self):
        bridge.TypingIndicator.INTERVAL_SECONDS = 0.05

        def slow_chat_send(*_args, **_kwargs):
            time.sleep(0.16)
            return quick("Hi there")

        self.cli_env.side_effect = slow_chat_send
        bridge.ask_agent(self.state, BOT, OPERATOR, "hello")

        # At least the immediate send plus a couple of repeats while chat_send
        # was still running.
        self.assertGreaterEqual(len(self.typing_calls()), 3)

    def test_typing_stops_once_the_reply_is_in_hand(self):
        bridge.TypingIndicator.INTERVAL_SECONDS = 0.05
        bridge.ask_agent(self.state, BOT, OPERATOR, "hello")
        count_after_reply = len(self.typing_calls())
        time.sleep(0.2)
        self.assertEqual(len(self.typing_calls()), count_after_reply)


if __name__ == "__main__":
    unittest.main()
