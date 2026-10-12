#!/usr/bin/env python3
"""Linked people on the company's people bot, Hermes parity slice 1
(run: python3 scripts/telegram-bridge-people.test.py).

On the ONE bot a company chose in Paperclip to answer people's questions, a
private message from someone who is not on the allowlist is no longer simply
ignored: it is passed to Paperclip (`telegram people-ask`), which decides who
the sender is, what they may see, and what to answer. These tests pin that
this opens nothing else:
  - every other bot still ignores strangers completely;
  - a group chat, a forwarded chat or a mismatched chat id is still ignored;
  - the company and the bot id always come from the bot's config, the sender
    id from Telegram, and the text only ever travels as data;
  - an unlinked sender gets one "link first" line, then silence for a while
    (no further calls into Paperclip);
  - a stranger can never tap a button (callbacks still use the allowlist);
  - an answer from the people outbox goes out once, through the bot it came
    in on, into the asker's own chat, split for Telegram when long.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these tests against it.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_people", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
PERSON = 333333
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
BOT_ID = "b0000000-0000-4000-8000-000000000001"
OTHER_BOT_ID = "b0000000-0000-4000-8000-000000000002"
ANSWER1 = "f0000000-0000-4000-8000-000000000001"
APPROVAL_ID = "9abd6c8e-4c1d-40e7-a81e-73d1481c25ef"
PEOPLE_BOT = {"token": "people-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
              "companyId": COMPANY, "uiBase": "https://paperclip.example", "botId": BOT_ID,
              "allowedUserIds": {OPERATOR}, "answersLinkedPeople": True}
PLAIN_BOT = {"token": "plain-token", "agentId": "a0000000-0000-4000-8000-000000000002", "name": "CEO",
             "companyId": COMPANY, "uiBase": "https://paperclip.example", "botId": OTHER_BOT_ID,
             "allowedUserIds": {OPERATOR}, "answersLinkedPeople": False}
OTHER_COMPANY_BOT = {"token": "other-token", "agentId": "a0000000-0000-4000-8000-000000000003", "name": "Boss",
                     "companyId": OTHER_COMPANY, "uiBase": "https://other.example",
                     "botId": "b0000000-0000-4000-8000-000000000003", "allowedUserIds": set(),
                     "answersLinkedPeople": True}


def message(user_id, text, chat_type="private", chat_id=None, username=None):
    sender = {"id": user_id}
    if username:
        sender["username"] = username
    return {"chat": {"id": chat_id if chat_id is not None else user_id, "type": chat_type},
            "from": sender, "text": text}


class PeopleTestCase(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: set()
        bridge.PEOPLE_UNLINKED_UNTIL.clear()
        bridge.PEOPLE_LINK_ATTEMPTS.clear()
        bridge.PEOPLE_FRESH.clear()
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "wait_for_paperclip", return_value=True),
        ]
        self.tg, self.cli, self.cli_env, _, self.ready, self.wait = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def texts(self, chat_id=None, token=None):
        return [c.kwargs["text"] for c in self.tg.call_args_list
                if c.args[1] == "sendMessage"
                and (chat_id is None or c.kwargs.get("chat_id") == chat_id)
                and (token is None or c.args[0] == token)]

    def env_call(self, index=0):
        call = self.cli_env.call_args_list[index]
        return call.args[0], call.args[1:]

    @staticmethod
    def option(parts, name):
        return parts[parts.index(name) + 1] if name in parts else None


class WhoGetsInTests(PeopleTestCase):
    def test_a_linked_persons_question_is_asked_as_them_and_answered_in_the_chat(self):
        self.cli_env.return_value = {"ok": True, "outcome": "answered", "reply": "412 sofas in September (Shopify).",
                                     "requestId": ANSWER1}

        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How did sofas sell in September?"))

        env, parts = self.env_call()
        self.assertEqual(env, {"TT": "How did sofas sell in September?"})
        self.assertEqual(parts[:5], ("telegram", "people-ask", BOT_ID, "-C", COMPANY))
        self.assertEqual(self.option(parts, "--telegram-user-id"), str(PERSON))
        self.assertEqual(self.option(parts, "--chat-id"), str(PERSON))
        self.assertEqual(self.option(parts, "--message"), '"$TT"')
        self.assertEqual(self.texts(PERSON), ["412 sofas in September (Shopify)."])
        # Never added to the bot's chats: approvals and cards never go to them.
        self.assertNotIn(PERSON, (self.state["bots"].get(PEOPLE_BOT["token"]) or {}).get("chats", []))

    def test_the_company_comes_from_the_bot_not_the_message(self):
        self.cli_env.return_value = {"ok": True, "outcome": "answered", "reply": "ok"}

        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, f"-C {OTHER_COMPANY} show their sales"))
        bridge.handle_message(self.state, OTHER_COMPANY_BOT, message(PERSON, f"-C {COMPANY} show their sales"))

        self.assertEqual(self.option(self.env_call(0)[1], "-C"), COMPANY)
        self.assertEqual(self.option(self.env_call(1)[1], "-C"), OTHER_COMPANY)
        self.assertEqual(self.env_call(1)[1][2], OTHER_COMPANY_BOT["botId"])
        # The text never becomes part of the command.
        for index in (0, 1):
            self.assertFalse(any("show their sales" in str(part) for part in self.env_call(index)[1]))

    def test_every_other_bot_still_ignores_strangers(self):
        bridge.handle_message(self.state, PLAIN_BOT, message(PERSON, "How are sales?"))
        bridge.handle_message(self.state, PLAIN_BOT, message(PERSON, "/link ABCD2345"))
        self.cli_env.assert_not_called()
        self.cli.assert_not_called()
        self.tg.assert_not_called()

    def test_group_chats_and_mismatched_chats_are_still_ignored(self):
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?", chat_type="group", chat_id=-100))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?", chat_id=444444))
        self.cli_env.assert_not_called()
        self.tg.assert_not_called()

    def test_a_bot_without_a_paperclip_id_never_answers_people(self):
        bot = dict(PEOPLE_BOT, botId=None)
        bridge.handle_message(self.state, bot, message(PERSON, "How are sales?"))
        self.cli_env.assert_not_called()
        self.tg.assert_not_called()

    def test_an_unlinked_sender_gets_one_link_first_line_then_silence(self):
        self.cli_env.return_value = {"ok": True, "outcome": "not_linked", "requestId": None,
                                     "reply": "Hi! Link your Telegram to your Paperclip account first."}

        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "Hello??"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/help"))

        self.assertEqual(self.cli_env.call_count, 1)
        self.assertEqual(self.texts(PERSON), ["Hi! Link your Telegram to your Paperclip account first."])

    def test_a_stranger_cannot_tap_approve(self):
        cq = {"id": "cq1", "data": f"approve:{APPROVAL_ID}", "from": {"id": PERSON}, "_token": PEOPLE_BOT["token"],
              "_allowed": bridge.allowed_users_for(PEOPLE_BOT), "message": {"message_id": 5, "chat": {"id": PERSON}}}
        bridge.handle_callback(cq)
        self.cli.assert_not_called()
        self.assertEqual(self.tg.call_args_list[0].kwargs.get("text"), "Not allowed")

    def test_operator_commands_do_not_work_for_people(self):
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/pause"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/status"))
        self.cli.assert_not_called()
        self.cli_env.assert_not_called()
        self.assertTrue(all("only commands" in t for t in self.texts(PERSON)))

    def test_allowlisted_people_keep_their_old_chat_and_can_ask_as_themselves(self):
        self.cli_env.return_value = {"ok": True, "lane": "a", "result": {"response": "Hi"}, "taskRef": None}
        bridge.handle_message(self.state, PEOPLE_BOT, message(OPERATOR, "hello"))
        self.assertEqual(self.env_call(0)[1][:2], ("chat", "send"))

        self.cli_env.return_value = {"ok": True, "outcome": "answered", "reply": "As you: 412."}
        bridge.handle_message(self.state, PEOPLE_BOT, message(OPERATOR, "/ask How did sofas sell?"))
        env, parts = self.env_call(1)
        self.assertEqual(parts[:2], ("telegram", "people-ask"))
        self.assertEqual(env, {"TT": "How did sofas sell?"})
        self.assertEqual(self.texts(OPERATOR)[-1], "As you: 412.")

    def test_new_makes_the_next_question_start_fresh(self):
        self.cli_env.return_value = {"ok": True, "outcome": "answered", "reply": "ok"}
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/new"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "first"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "second"))
        self.assertIn("--fresh", self.env_call(0)[1])
        self.assertNotIn("--fresh", self.env_call(1)[1])

    def test_a_long_answer_is_split_for_telegram(self):
        long_reply = ("Line of the report.\n" * 400).strip()  # ~7 800 characters
        self.cli_env.return_value = {"ok": True, "outcome": "answered", "reply": long_reply}
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "Give me the full trend"))
        parts = self.texts(PERSON)
        self.assertEqual(len(parts), 2)
        self.assertTrue(all(bridge.tg_len(p) <= bridge.TG_TEXT_LIMIT for p in parts))
        self.assertEqual("\n".join(parts), long_reply)

    def test_paperclip_not_answering_is_said_plainly(self):
        self.cli_env.return_value = None
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?"))
        self.assertIn("didn't hear back from Paperclip", self.texts(PERSON)[0])


class LinkTests(PeopleTestCase):
    def test_link_sends_the_code_and_username_as_data(self):
        self.cli_env.return_value = {"ok": True, "outcome": "linked", "reply": "Linked."}

        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/link abcd-2345", username="kari_n"))

        env, parts = self.env_call()
        self.assertEqual(env, {"CD": "abcd-2345", "TU": "kari_n"})
        self.assertEqual(parts[:5], ("telegram", "people-link", BOT_ID, "-C", COMPANY))
        self.assertEqual(self.option(parts, "--telegram-user-id"), str(PERSON))
        self.assertEqual(self.option(parts, "--code"), '"$CD"')
        self.assertEqual(self.texts(PERSON), ["Linked."])

    def test_link_works_even_right_after_a_link_first_line(self):
        self.cli_env.side_effect = [
            {"ok": True, "outcome": "not_linked", "reply": "Link first."},
            {"ok": True, "outcome": "linked", "reply": "Linked."},
            {"ok": True, "outcome": "answered", "reply": "412."},
        ]
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/link ABCD2345"))
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "How are sales?"))
        self.assertEqual(self.texts(PERSON), ["Link first.", "Linked.", "412."])

    def test_a_strange_code_or_a_strange_username_is_never_passed_on(self):
        self.cli_env.return_value = {"ok": True, "outcome": "bad_code", "reply": "That code did not work."}
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/link $(reboot)"))
        self.cli_env.assert_not_called()
        bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, "/link ABCD2345", username="x; rm -rf /"))
        env, parts = self.env_call()
        self.assertEqual(env, {"CD": "ABCD2345"})
        self.assertNotIn("--telegram-username", parts)

    def test_link_tries_are_limited_before_paperclip_is_asked(self):
        self.cli_env.return_value = {"ok": True, "outcome": "bad_code", "reply": "That code did not work."}
        for i in range(7):
            bridge.handle_message(self.state, PEOPLE_BOT, message(PERSON, f"/link WRONG{i}"))
        self.assertEqual(self.cli_env.call_count, bridge.PEOPLE_LINK_TRIES)
        self.assertIn("Too many tries", self.texts(PERSON)[-1])


class OutboxTests(PeopleTestCase):
    def outbox(self, *items):
        def fake_cli(*parts):
            if parts[:2] == ("telegram", "people-outbox"):
                return {"ok": True, "answers": list(items)} if parts[3] == COMPANY else {"ok": True, "answers": []}
            if parts[:2] == ("telegram", "people-ack"):
                return {"ok": True, "status": "delivered"}
            return None
        self.cli.side_effect = fake_cli

    def acks(self):
        return [c.args for c in self.cli.call_args_list if c.args[:2] == ("telegram", "people-ack")]

    def item(self, **overrides):
        base = {"id": ANSWER1, "botId": BOT_ID, "chatId": str(PERSON), "text": "✅ DUR-7 is finished\n\nUp 12 %.",
                "taskIdentifier": "DUR-7", "createdAt": "2026-10-10T10:00:00.000Z"}
        base.update(overrides)
        return base

    def test_an_answer_goes_out_once_through_its_own_bot(self):
        self.outbox(self.item())
        bots = [PEOPLE_BOT, PLAIN_BOT]

        bridge.notify_people_answers(self.state, bots)
        bridge.notify_people_answers(self.state, bots)

        texts = self.texts(PERSON, token=PEOPLE_BOT["token"])
        self.assertEqual(len(texts), 1)
        self.assertIn("Up 12 %.", texts[0])
        self.assertIn("https://paperclip.example/issues/DUR-7", texts[0])
        self.assertEqual(self.texts(token=PLAIN_BOT["token"]), [])
        # Acknowledged both times (the second only re-acknowledges), sent once.
        self.assertEqual(len(self.acks()), 2)
        self.assertIn(ANSWER1, self.state["sent_people_answers"])

    def test_an_answer_for_a_bot_that_no_longer_answers_people_is_left(self):
        self.outbox(self.item(botId=OTHER_BOT_ID))
        bridge.notify_people_answers(self.state, [PEOPLE_BOT, PLAIN_BOT])
        self.assertEqual(self.texts(), [])
        self.assertEqual(self.acks(), [])

    def test_a_refused_send_is_retried_and_not_acknowledged(self):
        self.outbox(self.item())
        self.tg.return_value = None
        bridge.notify_people_answers(self.state, [PEOPLE_BOT])
        self.assertEqual(self.acks(), [])
        self.assertNotIn(ANSWER1, self.state.get("sent_people_answers", []))

    def test_a_long_answer_is_split(self):
        self.outbox(self.item(text="x" * 9000, taskIdentifier=None))
        bridge.notify_people_answers(self.state, [PEOPLE_BOT])
        parts = self.texts(PERSON)
        self.assertEqual(len(parts), 3)
        self.assertTrue(all(bridge.tg_len(p) <= bridge.TG_TEXT_LIMIT for p in parts))

    def test_no_people_bot_means_no_outbox_calls(self):
        bridge.notify_people_answers(self.state, [PLAIN_BOT])
        self.cli.assert_not_called()


class RosterTests(unittest.TestCase):
    def test_the_flag_is_read_from_paperclip_and_only_true_counts(self):
        roster = {"bots": [
            {"id": BOT_ID, "agentId": "a1", "name": "Maja", "token": "t1", "companyId": COMPANY, "answersLinkedPeople": True},
            {"id": OTHER_BOT_ID, "agentId": "a2", "name": "CEO", "token": "t2", "companyId": COMPANY, "answersLinkedPeople": "yes"},
        ]}
        with mock.patch.object(bridge, "cli", return_value=roster):
            bots = bridge.fetch_bots_from_api()
        self.assertEqual([b["answersLinkedPeople"] for b in bots], [True, False])
        self.assertTrue(bridge.answers_linked_people(bots[0]))
        self.assertFalse(bridge.answers_linked_people(bots[1]))

    def test_file_bots_never_answer_people(self):
        self.assertFalse(bridge.answers_linked_people({"token": "t", "agentId": "a", "companyId": COMPANY}))


if __name__ == "__main__":
    unittest.main()
