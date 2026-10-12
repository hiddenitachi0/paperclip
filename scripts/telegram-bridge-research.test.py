#!/usr/bin/env python3
"""Research and plan tasks through Telegram (run: python3 scripts/telegram-bridge-research.test.py).

A quick agent now hands a research or planning request ("plan a trip", "find
the best price on X") to a task for itself, and a hand-over to a colleague is
a task too. These tests pin that such a task is followed like a /task one: the
chat it came from is remembered from the quick answer's actions, the finished
answer is posted there once, and a task with a result page links straight to
that page. Nothing else opens: a failed or malformed action is ignored, and
answers still only go to the chat that asked.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these tests against it.
"""
import importlib.util
import os
import re
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_research", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
OPERATOR2 = 222222
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
CONV1 = "d0000000-0000-4000-8000-000000000001"
ISSUE1 = "e0000000-0000-4000-8000-000000000001"
ISSUE2 = "e0000000-0000-4000-8000-000000000002"


def message(user_id, text):
    return {"chat": {"id": user_id, "type": "private"}, "from": {"id": user_id}, "text": text}


def quick_with_actions(response, actions):
    return {"ok": True, "lane": "a",
            "result": {"conversationId": CONV1, "response": response, "actions": actions}, "taskRef": None}


def research_action(issue_id=ISSUE1, identifier="DUR-31", title="Trip plan: 4 days in Rome", ok=True):
    return {"tool": "start_research_task", "summary": f"Started research task {identifier}: {title}.", "ok": ok,
            "task": {"issueId": issue_id, "identifier": identifier, "title": title}}


def answer_item(issue_id, status, body, result_page=True, identifier="DUR-31", comment_id="comment-1"):
    return {"id": issue_id, "companyId": COMPANY, "identifier": identifier, "title": "Trip plan: 4 days in Rome",
            "status": status,
            "answer": {"commentId": comment_id, "authorAgentId": BOT["agentId"], "body": body,
                       "createdAt": "2026-09-28T10:00:00.000Z"} if comment_id else None,
            "resultDocument": {"key": "result", "title": "Rome, 4 days"} if result_page else None}


class ResearchBridgeTestCase(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR, OPERATOR2]}}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR, OPERATOR2}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-09-28T08:00:00Z"),
            mock.patch.object(bridge, "wait_for_paperclip", return_value=True),
        ]
        self.tg, self.cli, self.cli_env = [p.start() for p in self.patches][:3]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def texts(self, chat_id=None):
        return [c.kwargs["text"] for c in self.tg.call_args_list
                if c.args[1] == "sendMessage" and (chat_id is None or c.kwargs.get("chat_id") == chat_id)]

    def tasks(self):
        return self.state["bots"][BOT["token"]].get("tasks") or {}


class HandOverTests(ResearchBridgeTestCase):
    def test_a_research_task_the_quick_agent_started_is_followed_in_the_chat_that_asked(self):
        self.cli_env.return_value = quick_with_actions(
            "I'm on it — I'll send the plan here when it's ready (DUR-31).", [research_action()])

        bridge.handle_message(self.state, BOT, message(OPERATOR2, "Plan 4 days in Rome in May for us two"))

        self.assertEqual(self.texts(OPERATOR2), ["I'm on it — I'll send the plan here when it's ready (DUR-31)."])
        entry = self.tasks()[ISSUE1]
        self.assertEqual(entry["chat"], OPERATOR2)
        self.assertEqual(entry["identifier"], "DUR-31")
        self.assertEqual(entry["title"], "Trip plan: 4 days in Rome")
        self.assertNotIn("colleague", entry)

    def test_when_it_is_done_the_summary_and_a_link_to_the_result_page_are_posted_once(self):
        self.cli_env.return_value = quick_with_actions("I'm on it.", [research_action()])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan 4 days in Rome"))
        self.cli.return_value = {"issues": [answer_item(
            ISSUE1, "done", "Your 4-day Rome plan is ready: about 14 500 NOK for two.\nPrices checked 28 Sep 10:00.")]}

        bridge.notify_task_answers(self.state, [BOT])
        bridge.notify_task_answers(self.state, [BOT])

        self.cli.assert_called_once_with("chat", "answers", "-C", COMPANY, ISSUE1)
        texts = self.texts(OPERATOR)
        self.assertEqual(len(texts), 2)  # "I'm on it." and the result
        result = texts[1]
        self.assertIn("✅ Maja finished DUR-31", result)
        self.assertIn("about 14 500 NOK for two", result)
        self.assertIn("Open the result page: https://paperclip.example/issues/DUR-31#document-result", result)
        self.assertNotIn(ISSUE1, self.tasks())

    def test_a_task_without_a_result_page_links_to_the_task_as_before(self):
        self.cli_env.return_value = quick_with_actions("I'm on it.", [research_action()])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan 4 days in Rome"))
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "Could not finish.", result_page=False)]}

        bridge.notify_task_answers(self.state, [BOT])

        text = self.texts(OPERATOR)[-1]
        self.assertIn("Open the task: https://paperclip.example/issues/DUR-31", text)
        self.assertNotIn("#document-result", text)

    def test_a_long_answer_points_to_the_result_page(self):
        self.cli_env.return_value = quick_with_actions("I'm on it.", [research_action()])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan 4 days in Rome"))
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "x" * 10000)]}

        bridge.notify_task_answers(self.state, [BOT])

        text = self.texts(OPERATOR)[-1]
        self.assertLessEqual(len(text.encode("utf-16-le")) // 2, 4096)
        self.assertIn("https://paperclip.example/issues/DUR-31#document-result", text)

    def test_a_hand_over_to_a_colleague_is_followed_without_saying_the_bot_did_it(self):
        self.cli_env.return_value = quick_with_actions("Bob has it as DUR-40.", [{
            "tool": "route_to_agent", "summary": "Handed to Bob as task DUR-40.", "ok": True,
            "task": {"issueId": ISSUE2, "identifier": "DUR-40", "title": "Fix the login page"}}])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Get Bob to fix the login page"))
        self.assertTrue(self.tasks()[ISSUE2]["colleague"])
        self.cli.return_value = {"issues": [answer_item(ISSUE2, "done", "Fixed.", result_page=False, identifier="DUR-40")]}

        bridge.notify_task_answers(self.state, [BOT])

        text = self.texts(OPERATOR)[-1]
        self.assertIn("✅ DUR-40 is finished", text)
        self.assertNotIn("Maja finished", text)

    def test_a_job_started_on_a_colleague_is_followed_like_a_hand_over(self):
        self.cli_env.return_value = quick_with_actions("Done. Started \"Revise contract\" on Legal Advisor as DUR-41.", [{
            "tool": "start_job", "summary": "Started job \"Revise contract\" on Legal Advisor as DUR-41.", "ok": True,
            "task": {"issueId": ISSUE2, "identifier": "DUR-41", "title": "Revise contract"}}])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Get the Legal Advisor to revise this contract"))
        self.assertTrue(self.tasks()[ISSUE2]["colleague"])
        self.cli.return_value = {"issues": [answer_item(ISSUE2, "done", "Revised.", result_page=False, identifier="DUR-41")]}

        bridge.notify_task_answers(self.state, [BOT])

        text = self.texts(OPERATOR)[-1]
        self.assertIn("✅ DUR-41 is finished", text)
        self.assertNotIn("Maja finished", text)

    def test_a_failed_or_malformed_action_starts_nothing_to_follow(self):
        self.cli_env.return_value = quick_with_actions("Sorry.", [
            research_action(ok=False),
            {"tool": "start_research_task", "ok": True, "summary": "x", "task": {"issueId": "not-a-uuid"}},
            {"tool": "start_research_task", "ok": True, "summary": "x", "task": "DUR-1"},
            {"tool": "get_weather", "ok": True, "summary": "Weather"},
        ])

        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan a trip"))

        self.assertEqual(self.tasks(), {})

    def test_the_same_task_twice_in_one_answer_is_followed_once(self):
        self.cli_env.return_value = quick_with_actions("On it.", [research_action(), research_action()])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan a trip"))
        self.assertEqual(list(self.tasks()), [ISSUE1])

    def test_the_result_is_never_posted_to_another_chat(self):
        self.cli_env.return_value = quick_with_actions("On it.", [research_action()])
        bridge.handle_message(self.state, BOT, message(OPERATOR, "Plan 4 days in Rome"))
        self.cli.return_value = {"issues": [answer_item(ISSUE1, "done", "Ready.")]}

        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(self.texts(OPERATOR2), [])


class ContractTests(unittest.TestCase):
    def read(self, *path):
        with open(os.path.join(REPO, *path)) as f:
            return f.read()

    def test_the_result_document_key_matches_the_server(self):
        src = self.read("packages", "shared", "src", "research-tasks.ts")
        key = re.search(r'RESEARCH_RESULT_DOCUMENT_KEY = "([a-z0-9_-]+)"', src).group(1)
        self.assertEqual(key, bridge.RESULT_DOCUMENT_KEY)

    def test_the_server_sends_the_result_page_and_the_task_on_each_action(self):
        answers = self.read("server", "src", "routes", "issue-answers.ts")
        self.assertIn("resultDocument", answers)
        lane_a = self.read("server", "src", "services", "lane-a.ts")
        self.assertIn("task: result.task", lane_a)
        tools = self.read("server", "src", "services", "lane-a-tools.ts")
        self.assertIn('"start_research_task"', tools)
        self.assertIn('"route_to_agent"', tools)
        self.assertIn('"start_job"', tools)

    def test_the_bridge_treats_start_job_as_a_colleague_hand_over(self):
        bridge_src = self.read("scripts", "telegram-bridge.py")
        self.assertIn("start_job", bridge_src)


if __name__ == "__main__":
    unittest.main()
