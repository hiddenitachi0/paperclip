#!/usr/bin/env python3
"""Two-way chat with the Telegram bots, DUR-3978 (run: python3 scripts/telegram-bridge-chat.test.py).

Before this, a message to a bot only ever became a task and the answer never
came back to Telegram. These tests pin that a quick question is answered in the
same chat, that the chat keeps its conversation until /new, that a task's answer
is posted once and only into the chat the task came from, and that none of this
opens a door: strangers and groups still get nothing, the company always comes
from the bot's config, and no message text can approve or reject anything.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these tests against it (used to prove they fail on the code before DUR-3978).
"""
import importlib.util
import json
import os
import re
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_chat", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
OPERATOR2 = 222222
STRANGER = 999999
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "CEO",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
OTHER_BOT = {"token": "other-token", "agentId": "a0000000-0000-4000-8000-000000000002", "name": "Boss",
             "companyId": OTHER_COMPANY, "uiBase": "https://other.example"}
CONV1 = "d0000000-0000-4000-8000-000000000001"
CONV2 = "d0000000-0000-4000-8000-000000000002"
ISSUE1 = "e0000000-0000-4000-8000-000000000001"
ISSUE2 = "e0000000-0000-4000-8000-000000000002"
APPROVAL_ID = "9abd6c8e-4c1d-40e7-a81e-73d1481c25ef"


def message(user_id, text, chat_type="private", chat_id=None):
    return {"chat": {"id": chat_id if chat_id is not None else user_id, "type": chat_type},
            "from": {"id": user_id}, "text": text}


def quick(conversation_id, response):
    return {"ok": True, "lane": "a", "result": {"conversationId": conversation_id, "response": response},
            "taskRef": None}


def task(issue_id, identifier):
    return {"ok": True, "lane": "b", "result": None,
            "taskRef": {"issueId": issue_id, "identifier": identifier, "status": "todo"}}


def refused(status, code=None, error="Refused"):
    return {"ok": False, "status": status, "code": code, "error": error}


def answer_item(issue_id, status, comment_id, body, company_id=COMPANY, identifier="DUR-5"):
    return {"id": issue_id, "companyId": company_id, "identifier": identifier, "title": "What is our cash?",
            "status": status,
            "answer": {"commentId": comment_id, "authorAgentId": BOT["agentId"], "body": body,
                       "createdAt": "2026-09-16T10:00:00.000Z"} if comment_id else None}


def tracked(chat, identifier="DUR-5"):
    return {"chat": chat, "identifier": identifier, "title": "What is our cash?", "at": time.time()}


class BridgeChatTestCase(unittest.TestCase):
    def setUp(self):
        self.state = {
            "bots": {
                BOT["token"]: {"offset": 0, "chats": [OPERATOR, OPERATOR2]},
                OTHER_BOT["token"]: {"offset": 0, "chats": [OPERATOR]},
            },
            "notified": [],
        }
        bridge.ALLOWED_USER_IDS = {OPERATOR, OPERATOR2}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.cli, self.cli_env, _ = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def sends(self, chat_id=None, token=None):
        return [c.kwargs for c in self.tg.call_args_list
                if c.args[1] == "sendMessage"
                and (chat_id is None or c.kwargs.get("chat_id") == chat_id)
                and (token is None or c.args[0] == token)]

    def texts(self, chat_id=None):
        return [s["text"] for s in self.sends(chat_id)]

    def chat_send(self, index):
        """(env, command parts) of the index-th cli_env call."""
        call = self.cli_env.call_args_list[index]
        return call.args[0], call.args[1:]

    def option(self, parts, name):
        return parts[parts.index(name) + 1] if name in parts else None

    def tasks(self, bot=BOT):
        return self.state["bots"][bot["token"]].get("tasks") or {}


class QuickAnswerTests(BridgeChatTestCase):
    def test_a_quick_question_is_answered_in_the_same_chat(self):
        self.cli_env.return_value = quick(CONV1, "Two agents are working right now.")

        bridge.handle_message(self.state, BOT, message(OPERATOR, "how many agents are working?"))

        env, parts = self.chat_send(0)
        self.assertEqual(env, {"TT": "how many agents are working?"})
        self.assertEqual(parts[:5], ("chat", "send", BOT["agentId"], "-C", COMPANY))
        self.assertIsNone(self.option(parts, "--lane"))
        self.assertIsNone(self.option(parts, "--conversation-id"))
        self.assertEqual(self.texts(OPERATOR), ["Two agents are working right now."])
        self.assertEqual(self.sends(OPERATOR2), [])

    def test_a_follow_up_question_continues_the_same_conversation(self):
        self.cli_env.side_effect = [quick(CONV1, "Two."), quick(CONV1, "Finn and Bob.")]

        bridge.handle_message(self.state, BOT, message(OPERATOR, "how many agents are working?"))
        bridge.handle_message(self.state, BOT, message(OPERATOR, "who are they?"))

        self.assertIsNone(self.option(self.chat_send(0)[1], "--conversation-id"))
        self.assertEqual(self.option(self.chat_send(1)[1], "--conversation-id"), CONV1)
        self.assertEqual(self.texts(OPERATOR), ["Two.", "Finn and Bob."])

    def test_new_starts_a_fresh_conversation(self):
        self.cli_env.side_effect = [quick(CONV1, "Two."), quick(CONV2, "Hello again.")]

        bridge.handle_message(self.state, BOT, message(OPERATOR, "how many agents are working?"))
        bridge.handle_message(self.state, BOT, message(OPERATOR, "/new"))
        self.assertEqual(self.cli_env.call_count, 1)
        bridge.handle_message(self.state, BOT, message(OPERATOR, "hello"))

        self.assertIsNone(self.option(self.chat_send(1)[1], "--conversation-id"))
        self.assertTrue(any("Fresh start" in t for t in self.texts(OPERATOR)))
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV2)

    def test_each_chat_and_each_bot_keeps_its_own_conversation(self):
        conv3 = "d0000000-0000-4000-8000-000000000003"
        self.cli_env.side_effect = [quick(CONV1, "a"), quick(CONV2, "b"), quick(conv3, "c"),
                                    quick(CONV1, "d"), quick(conv3, "e")]

        bridge.handle_message(self.state, BOT, message(OPERATOR, "first"))
        bridge.handle_message(self.state, BOT, message(OPERATOR2, "second"))
        bridge.handle_message(self.state, OTHER_BOT, message(OPERATOR, "third"))
        bridge.handle_message(self.state, BOT, message(OPERATOR, "fourth"))
        bridge.handle_message(self.state, OTHER_BOT, message(OPERATOR, "fifth"))

        self.assertIsNone(self.option(self.chat_send(1)[1], "--conversation-id"))
        self.assertIsNone(self.option(self.chat_send(2)[1], "--conversation-id"))
        self.assertEqual(self.option(self.chat_send(3)[1], "--conversation-id"), CONV1)
        self.assertEqual(self.option(self.chat_send(4)[1], "--conversation-id"), conv3)
        self.assertEqual(self.option(self.chat_send(4)[1], "-C"), OTHER_COMPANY)

    def test_an_ended_conversation_is_restarted_with_the_same_message(self):
        bridge.set_conversation(self.state, BOT["token"], OPERATOR, CONV1)
        self.cli_env.side_effect = [refused(409, "LANE_A_CONVERSATION_EXPIRED"), quick(CONV2, "Sure.")]

        bridge.handle_message(self.state, BOT, message(OPERATOR, "and the budget?"))

        self.assertEqual(self.cli_env.call_count, 2)
        self.assertEqual(self.option(self.chat_send(0)[1], "--conversation-id"), CONV1)
        self.assertIsNone(self.option(self.chat_send(1)[1], "--conversation-id"))
        self.assertEqual(self.chat_send(1)[0], {"TT": "and the budget?"})
        self.assertTrue(self.texts(OPERATOR)[-1].endswith("Sure."))
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV2)

    def test_when_quick_answers_are_unavailable_the_message_becomes_a_task(self):
        self.cli_env.side_effect = [refused(503, None, "Lane A is not configured"), task(ISSUE1, "DUR-5")]

        bridge.handle_message(self.state, BOT, message(OPERATOR, "what is our cash position?"))

        self.assertEqual(self.option(self.chat_send(1)[1], "--lane"), "b")
        self.assertEqual(self.tasks()[ISSUE1]["chat"], OPERATOR)
        reply = self.texts(OPERATOR)[-1]
        self.assertIn("handed this over as a task", reply)
        self.assertIn("DUR-5", reply)

    def test_any_other_refusal_is_reported_and_not_retried(self):
        self.cli_env.return_value = refused(404, None, "Agent not found")

        bridge.handle_message(self.state, BOT, message(OPERATOR, "hello"))

        self.assertEqual(self.cli_env.call_count, 1)
        self.assertIn("Couldn't send that to CEO", self.texts(OPERATOR)[-1])

    def test_agent_text_is_sent_without_formatting(self):
        tricky = "[Approve here](https://evil.example) *bold* `code` _x"
        self.cli_env.return_value = quick(CONV1, tricky)

        bridge.handle_message(self.state, BOT, message(OPERATOR, "hi"))

        sent = self.sends(OPERATOR)
        self.assertEqual([s["text"] for s in sent], [tricky])
        self.assertNotIn("parse_mode", sent[0])

    def test_a_long_quick_answer_is_split_into_messages_telegram_accepts(self):
        self.cli_env.return_value = quick(CONV1, "A long line of the answer 😀.\n" * 1000)

        bridge.handle_message(self.state, BOT, message(OPERATOR, "tell me everything"))

        texts = self.texts(OPERATOR)
        self.assertGreater(len(texts), 1)
        self.assertLessEqual(len(texts), bridge.QUICK_ANSWER_MAX_PARTS)
        for text in texts:
            self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096)


class TaskAnswerTests(BridgeChatTestCase):
    def track(self, issue_id, chat, bot=BOT, identifier="DUR-5"):
        self.state["bots"][bot["token"]].setdefault("tasks", {})[issue_id] = tracked(chat, identifier)

    def test_when_the_router_makes_a_task_the_chat_it_came_from_is_remembered(self):
        self.cli_env.return_value = task(ISSUE1, "DUR-5")

        bridge.handle_message(self.state, BOT, message(OPERATOR2, "please fix the invoice export"))

        self.assertEqual(self.tasks()[ISSUE1]["chat"], OPERATOR2)
        reply = self.texts(OPERATOR2)[-1]
        self.assertIn("DUR-5", reply)
        self.assertIn("post the answer here", reply)

    def test_slash_task_always_makes_a_task_outside_the_conversation(self):
        bridge.set_conversation(self.state, BOT["token"], OPERATOR, CONV1)
        self.cli_env.return_value = task(ISSUE1, "DUR-5")

        bridge.handle_message(self.state, BOT, message(OPERATOR, "/task what is 2+2"))

        env, parts = self.chat_send(0)
        self.assertEqual(env, {"TT": "what is 2+2"})
        self.assertEqual(self.option(parts, "--lane"), "b")
        self.assertIsNone(self.option(parts, "--conversation-id"))

    def test_the_answer_is_posted_once_to_the_chat_the_task_came_from(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-1", "About 1.2 MNOK.")]}

        bridge.notify_task_answers(self.state, [BOT])
        bridge.notify_task_answers(self.state, [BOT])

        self.cli.assert_called_once_with("chat", "answers", "-C", COMPANY, ISSUE1)
        sent = self.sends()
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0]["chat_id"], OPERATOR)
        self.assertIn("About 1.2 MNOK.", sent[0]["text"])
        self.assertIn("https://paperclip.example/issues/DUR-5", sent[0]["text"])
        self.assertNotIn("parse_mode", sent[0])
        self.assertNotIn(ISSUE1, self.tasks())

    def test_a_posted_answer_is_not_posted_again_after_a_restart(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "in_review", "comment-1", "Please approve the plan.")]}
        bridge.notify_task_answers(self.state, [BOT])
        self.assertEqual(len(self.sends()), 1)

        # A restart reloads the state from the file.
        self.state = json.loads(json.dumps(self.state))
        bridge.notify_task_answers(self.state, [BOT])
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-1", "Please approve the plan.")]}
        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(len(self.sends()), 1)
        self.assertNotIn(ISSUE1, self.tasks())

    def test_a_new_answer_after_waiting_is_posted_too(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "blocked", "comment-1", "Waiting for the bank.")]}
        bridge.notify_task_answers(self.state, [BOT])
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-2", "The bank answered: 1.2 MNOK.")]}
        bridge.notify_task_answers(self.state, [BOT])

        texts = self.texts(OPERATOR)
        self.assertEqual(len(texts), 2)
        self.assertIn("The bank answered", texts[1])

    def test_an_answer_telegram_did_not_accept_is_tried_again(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-1", "Done.")]}
        self.tg.side_effect = [None, {}]

        bridge.notify_task_answers(self.state, [BOT])
        self.assertIn(ISSUE1, self.tasks())
        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(self.tg.call_count, 2)
        self.assertNotIn(ISSUE1, self.tasks())

    def test_nothing_is_posted_while_the_task_is_still_being_worked_on(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "in_progress", "comment-1", "Working on it.")]}

        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(self.sends(), [])
        self.assertIn(ISSUE1, self.tasks())

    def test_an_answer_is_never_posted_to_another_chat(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [
            answer_item(ISSUE1, "done", "comment-1", "Answer for the operator."),
            # Not a task from any of this bot's chats: must be ignored.
            answer_item(ISSUE2, "done", "comment-2", "Someone else's answer."),
        ]}

        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(self.sends(OPERATOR2), [])
        self.assertEqual(len(self.sends(OPERATOR)), 1)
        self.assertFalse(any("Someone else's answer." in t for t in self.texts()))

    def test_another_companys_task_is_never_posted(self):
        self.track(ISSUE1, OPERATOR, bot=BOT)
        self.track(ISSUE2, OPERATOR, bot=OTHER_BOT, identifier="NOR-9")

        def answers(*parts):
            company = parts[3]
            if company == COMPANY:
                # Even if an answer for this id came back labelled with another
                # company, the CEO bot must not post it.
                return {"issues": [answer_item(ISSUE1, "done", "comment-1", "Wrong company.", company_id=OTHER_COMPANY)]}
            return {"issues": [answer_item(ISSUE2, "done", "comment-2", "Boss answer.", company_id=OTHER_COMPANY,
                                           identifier="NOR-9")]}
        self.cli.side_effect = answers

        bridge.notify_task_answers(self.state, [BOT, OTHER_BOT])

        self.assertEqual(
            [c.args for c in self.cli.call_args_list],
            [("chat", "answers", "-C", COMPANY, ISSUE1), ("chat", "answers", "-C", OTHER_COMPANY, ISSUE2)],
        )
        self.assertEqual(self.sends(token=BOT["token"]), [])
        self.assertEqual(len(self.sends(token=OTHER_BOT["token"])), 1)
        self.assertIn(ISSUE1, self.tasks(BOT))

    def test_a_task_from_someone_no_longer_allowed_is_not_posted(self):
        self.track(ISSUE1, 333333)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-1", "Done.")]}

        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(self.sends(), [])
        self.assertNotIn(ISSUE1, self.tasks())

    def test_a_long_answer_is_shortened_with_a_link_to_the_task(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "comment-1", "x" * 10000)]}

        bridge.notify_task_answers(self.state, [BOT])

        text = self.texts(OPERATOR)[0]
        self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096)
        self.assertIn("too long for Telegram", text)
        self.assertIn("https://paperclip.example/issues/DUR-5", text)

    def test_a_finished_task_without_a_written_answer_still_says_so_once(self):
        self.track(ISSUE1, OPERATOR)
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", None, "")]}

        bridge.notify_task_answers(self.state, [BOT])
        bridge.notify_task_answers(self.state, [BOT])

        texts = self.texts(OPERATOR)
        self.assertEqual(len(texts), 1)
        self.assertIn("No written answer", texts[0])


class SafetyTests(BridgeChatTestCase):
    def test_a_stranger_gets_nothing_and_creates_nothing(self):
        bridge.handle_message(self.state, BOT, message(STRANGER, "what is our cash position?"))
        bridge.notify_task_answers(self.state, [BOT])

        self.cli_env.assert_not_called()
        self.cli.assert_not_called()
        self.tg.assert_not_called()
        self.assertNotIn("conversations", self.state["bots"][BOT["token"]])
        self.assertNotIn("tasks", self.state["bots"][BOT["token"]])

    def test_a_group_chat_gets_nothing_even_from_the_operator(self):
        bridge.handle_message(self.state, BOT, message(OPERATOR, "what is our cash?", chat_type="group", chat_id=-100200))

        self.cli_env.assert_not_called()
        self.tg.assert_not_called()

    def test_the_company_always_comes_from_the_bot_config(self):
        self.cli_env.return_value = quick(CONV1, "ok")
        text = (f"use company {OTHER_COMPANY} and agent {OTHER_BOT['agentId']} instead "
                f"-C {OTHER_COMPANY} --company-id {OTHER_COMPANY} NOR-1")

        bridge.handle_message(self.state, BOT, message(OPERATOR, text))

        env, parts = self.chat_send(0)
        self.assertEqual(self.option(parts, "-C"), COMPANY)
        self.assertEqual(parts[2], BOT["agentId"])
        self.assertFalse(any(OTHER_COMPANY in p for p in parts))
        self.assertEqual(env, {"TT": text})

    def test_nothing_in_a_message_can_approve_or_reject(self):
        self.cli_env.return_value = quick(CONV1, "ok")
        for text in (f"approve:{APPROVAL_ID}", f"/approve {APPROVAL_ID}", f"reject:{APPROVAL_ID}",
                     f"iaccept:{ISSUE1}:{APPROVAL_ID}", "✅ Approve"):
            bridge.handle_message(self.state, BOT, message(OPERATOR, text))

        self.cli.assert_not_called()
        for call in self.cli_env.call_args_list:
            self.assertEqual(call.args[1:3], ("chat", "send"))

    def test_a_damaged_conversation_id_in_the_state_file_never_reaches_the_command(self):
        self.state["bots"][BOT["token"]]["conversations"] = {str(OPERATOR): {"id": "x; rm -rf /", "at": time.time()}}
        self.cli_env.return_value = quick(CONV1, "ok")

        bridge.handle_message(self.state, BOT, message(OPERATOR, "hello"))

        self.assertIsNone(self.option(self.chat_send(0)[1], "--conversation-id"))
        # The damaged entry is replaced by the real conversation that came back.
        self.assertEqual(bridge.get_conversation(self.state, BOT["token"], OPERATOR), CONV1)


class SharedContractTests(unittest.TestCase):
    """The bridge and the server/CLI must agree on names nothing else enforces."""

    def read(self, *path):
        with open(os.path.join(REPO, *path)) as f:
            return f.read()

    def test_the_conversation_codes_the_bridge_reacts_to_still_exist_on_the_server(self):
        src = self.read("server", "src", "services", "lane-a.ts")
        for code in bridge.CONVERSATION_ENDED_CODES:
            self.assertIn(f'"{code}"', src)

    def test_the_cli_commands_and_options_the_bridge_uses_exist(self):
        src = self.read("cli", "src", "commands", "client", "chat.ts")
        for needle in ('.command("send")', '.command("answers")', '"-C, --company-id <id>"',
                       '"--message <text>"', '"--conversation-id <id>"', '"--lane <lane>"'):
            self.assertIn(needle, src)
        self.assertIn("registerChatCommands(program)", self.read("cli", "src", "index.ts"))

    def test_the_answers_per_call_limit_matches_the_server(self):
        src = self.read("server", "src", "routes", "issue-answers.ts")
        self.assertEqual(int(re.search(r"ISSUE_ANSWERS_MAX_IDS = (\d+)", src).group(1)), bridge.TASK_ANSWERS_PER_CALL)

    def test_the_task_statuses_the_bridge_waits_for_are_real_statuses(self):
        src = self.read("packages", "shared", "src", "constants.ts")
        block = re.search(r"export const ISSUE_STATUSES = \[(.*?)\]", src, re.S).group(1)
        statuses = set(re.findall(r'"([a-z_]+)"', block))
        for status in bridge.ANSWER_FINISHED_STATUSES + bridge.ANSWER_WAITING_STATUSES:
            self.assertIn(status, statuses)


if __name__ == "__main__":
    unittest.main(verbosity=2)
