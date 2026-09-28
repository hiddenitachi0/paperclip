#!/usr/bin/env python3
"""/cont, /memory, /looks and the updated /help (run: python3 scripts/telegram-bridge-cont.test.py).

A quick-answer conversation ends after 30 quiet minutes. /cont starts a new
one that carries on from the earlier chat: these tests pin that the words go
to Paperclip only as data in an environment variable, that the new
conversation is stored so the next message continues it, that a refusal is
passed on plainly, and that the other commands keep working.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_cont", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
CONV1 = "d0000000-0000-4000-8000-000000000001"
CONV2 = "d0000000-0000-4000-8000-000000000002"


def message(text, user_id=OPERATOR):
    return {"chat": {"id": user_id, "type": "private"}, "from": {"id": user_id}, "text": text}


def continued(conversation_id, recap):
    return {"ok": True, "conversationId": conversation_id, "mode": "time", "recap": recap,
            "matchedMessages": 2, "consideredMessages": 2, "fromConversations": 1}


def quick(conversation_id, response):
    return {"ok": True, "lane": "a", "result": {"conversationId": conversation_id, "response": response},
            "taskRef": None}


class BridgeContTestCase(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-09-28T12:00:00Z"),
            mock.patch.object(bridge, "wait_for_paperclip", return_value=True),
        ]
        self.tg, self.cli, self.cli_env, _, self.ready, _, _ = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def texts(self):
        return [c.kwargs["text"] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def call(self, index):
        c = self.cli_env.call_args_list[index]
        return c.args[0], c.args[1:]


class ContTests(BridgeContTestCase):
    def test_cont_with_words_passes_them_only_as_data_and_stores_the_new_conversation(self):
        self.cli_env.return_value = continued(CONV2, "the last 45 minutes (2 messages). Last thing you said: \"Draft it\"")

        bridge.handle_message(self.state, BOT, message("/cont last 45 minutes; rm -rf /"))

        env, parts = self.call(0)
        self.assertEqual(env, {"CS": "last 45 minutes; rm -rf /"})
        self.assertEqual(parts, ("chat", "continue", BOT["agentId"], "-C", COMPANY, "--spec", '"$CS"'))
        self.assertNotIn("rm -rf", " ".join(parts))
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV2)
        self.assertEqual(len(self.texts()), 1)
        self.assertTrue(self.texts()[0].startswith("🔁 Continuing from: the last 45 minutes (2 messages)."))
        # Agent text goes out without formatting.
        sends = [c.kwargs for c in self.tg.call_args_list if c.args[1] == "sendMessage"]
        self.assertNotIn("parse_mode", sends[0])

    def test_cont_alone_means_the_last_conversation_and_sends_no_spec(self):
        self.cli_env.return_value = continued(CONV2, "your last conversation (4 messages).")

        bridge.handle_message(self.state, BOT, message("/cont"))

        env, parts = self.call(0)
        self.assertEqual(env, {})
        self.assertNotIn("--spec", parts)
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV2)

    def test_the_next_message_continues_the_new_conversation(self):
        bridge.set_conversation(self.state, BOT["token"], OPERATOR, CONV1)
        self.cli_env.side_effect = [continued(CONV2, "Preparing the meeting."), quick(CONV2, "Right, the agenda.")]

        bridge.handle_message(self.state, BOT, message("/cont our meeting today"))
        bridge.handle_message(self.state, BOT, message("where were we?"))

        env, parts = self.call(1)
        self.assertEqual(env, {"TT": "where were we?"})
        self.assertEqual(parts[parts.index("--conversation-id") + 1], CONV2)
        self.assertEqual(self.texts()[-1], "Right, the agenda.")

    def test_a_long_spec_is_cut_to_the_server_limit(self):
        self.cli_env.return_value = continued(CONV2, "x")
        bridge.handle_message(self.state, BOT, message("/cont " + "a" * 500))
        env, _ = self.call(0)
        self.assertEqual(len(env["CS"]), bridge.CONTINUE_SPEC_MAX_CHARS)

    def test_nothing_to_continue_is_passed_on_plainly_and_keeps_the_old_conversation(self):
        bridge.set_conversation(self.state, BOT["token"], OPERATOR, CONV1)
        self.cli_env.return_value = {"ok": False, "status": 422, "code": "LANE_A_CONTINUE_NOTHING_FOUND",
                                     "error": "I found no messages with Maja from the last 30 minutes, so there is nothing to continue."}

        bridge.handle_message(self.state, BOT, message("/cont last 30 minutes"))

        self.assertEqual(self.texts(), [
            "🔁 I found no messages with Maja from the last 30 minutes, so there is nothing to continue."])
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV1)

    def test_quick_answers_switched_off_is_said_in_plain_words(self):
        self.cli_env.return_value = {"ok": False, "status": 403, "code": None, "error": "Lane A is not enabled for this agent"}
        bridge.handle_message(self.state, BOT, message("/cont"))
        self.assertEqual(self.texts(), [
            "Maja doesn't have quick answers switched on, so there's no conversation to continue."])

    def test_no_answer_from_paperclip_says_so(self):
        bridge.handle_message(self.state, BOT, message("/cont"))
        self.assertIn("didn't hear back from Paperclip", self.texts()[0])
        self.assertIsNone(bridge.get_conversation(self.state, BOT["token"], OPERATOR))

    def test_during_a_restart_nothing_is_sent(self):
        self.ready.return_value = False
        bridge.handle_message(self.state, BOT, message("/cont"))
        self.cli_env.assert_not_called()
        self.assertIn("Paperclip is restarting", self.texts()[0])

    def test_similar_words_are_not_the_command(self):
        self.cli_env.return_value = quick(CONV1, "Sure.")
        bridge.handle_message(self.state, BOT, message("/contact the supplier"))
        _, parts = self.call(0)
        self.assertEqual(parts[:2], ("chat", "send"))

    def test_the_cli_command_and_codes_the_bridge_uses_exist(self):
        with open(os.path.join(REPO, "cli", "src", "commands", "client", "chat.ts")) as f:
            cli_src = f.read()
        for needle in ('.command("continue")', '.command("memory")', '.command("looks")', '"--spec <text>"'):
            self.assertIn(needle, cli_src)
        with open(os.path.join(REPO, "server", "src", "services", "lane-a-continue.ts")) as f:
            server_src = f.read()
        for code in bridge.CONTINUE_NOTHING_CODES:
            self.assertIn(f'"{code}"', server_src)
        self.assertIn(f"LANE_A_CONTINUE_SPEC_MAX_LENGTH = {bridge.CONTINUE_SPEC_MAX_CHARS};", server_src)


class MemoryAndLooksTests(BridgeContTestCase):
    def test_memory_lists_the_notes_newest_first_and_short(self):
        notes = [{"id": f"n{i}", "text": f"Note {i}"} for i in range(20)]
        self.cli.return_value = {"ok": True, "notes": notes}

        bridge.handle_message(self.state, BOT, message("/memory"))

        self.cli.assert_called_once_with("chat", "memory", BOT["agentId"], "-C", COMPANY)
        text = self.texts()[0]
        self.assertTrue(text.startswith("🧠 What Maja remembers (20):\n• Note 0\n"))
        self.assertIn("• Note 14", text)
        self.assertNotIn("• Note 15", text)
        self.assertIn("…and 5 older ones.", text)

    def test_memory_empty_and_refused(self):
        self.cli.return_value = {"ok": True, "notes": []}
        bridge.handle_message(self.state, BOT, message("/memory"))
        self.assertIn("hasn't been asked to remember anything yet", self.texts()[0])
        self.cli.return_value = {"ok": False, "status": 403, "code": None,
                                 "error": "Only people who can change this agent's settings can see and change its memory."}
        bridge.handle_message(self.state, BOT, message("/memory"))
        self.assertEqual(self.texts()[1], "Couldn't read Maja's memory. Paperclip said: Only people who can change "
                                          "this agent's settings can see and change its memory.")

    def test_looks_shows_the_tool_answer_or_says_it_is_not_ticked(self):
        self.cli.return_value = {"ok": True, "available": True, "text": "Saved looks:\n- Nordic calm"}
        bridge.handle_message(self.state, BOT, message("/looks"))
        self.cli.assert_called_with("chat", "looks", BOT["agentId"], "-C", COMPANY)
        self.assertEqual(self.texts()[0], "🎨 Saved looks:\n- Nordic calm")

        self.cli.return_value = {"ok": True, "available": False,
                                 "text": 'Maja cannot list saved looks: the "List saved looks" add-on tool is not ticked for it.'}
        bridge.handle_message(self.state, BOT, message("/looks"))
        self.assertIn("is not ticked for it", self.texts()[1])
        self.cli_env.assert_not_called()


class HelpTests(BridgeContTestCase):
    def test_help_lists_every_command_with_cont_examples(self):
        for command in ("/help", "/start"):
            self.tg.reset_mock()
            bridge.handle_message(self.state, BOT, message(command))
            text = self.texts()[0]
            for needle in ("you're talking to Maja", "/task <text>", "/new", "`/cont`", "/cont last 45 minutes",
                           "/cont our meeting today", "/memory", "/looks", "/project <name>", "/status"):
                self.assertIn(needle, text, command)
        self.cli_env.assert_not_called()

    def test_existing_commands_still_work(self):
        bridge.set_conversation(self.state, BOT["token"], OPERATOR, CONV1)
        bridge.handle_message(self.state, BOT, message("/new"))
        self.assertIsNone(bridge.get_conversation(self.state, BOT["token"], OPERATOR))
        self.cli.side_effect = [[], []]
        bridge.handle_message(self.state, BOT, message("/status"))
        self.assertTrue(any(t.startswith("*Now:*") for t in self.texts()))


if __name__ == "__main__":
    unittest.main()
