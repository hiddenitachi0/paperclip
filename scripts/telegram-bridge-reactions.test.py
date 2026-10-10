#!/usr/bin/env python3
"""Emoji reactions as feedback (DUR-4344; run: python3 scripts/telegram-bridge-reactions.test.py)."""
import importlib.util
import json
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("telegram_bridge", os.path.join(HERE, "telegram-bridge.py"))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
STRANGER = 999999
CONV = "33333333-3333-4333-8333-333333333333"
MSG = "44444444-4444-4444-8444-444444444444"
FILE = "55555555-5555-4555-8555-555555555555"
BOT = {"token": "bot-token", "agentId": "agent-1", "name": "CEO", "companyId": "company-1", "uiBase": "https://x"}
TARGET = {"agentId": "agent-1", "conversationId": CONV, "messageId": MSG}


def reaction(user_id=OPERATOR, old=(), new=(), message_id=50):
    return {
        "chat": {"id": OPERATOR, "type": "private"},
        "message_id": message_id,
        "user": {"id": user_id},
        "old_reaction": [{"type": "emoji", "emoji": e} for e in old],
        "new_reaction": [{"type": "emoji", "emoji": e} for e in new],
    }


class ParsingTests(unittest.TestCase):
    def events(self, update, target=TARGET, allowed=(OPERATOR,)):
        return bridge.reaction_events(update, BOT, target, set(allowed))

    def test_a_new_reaction_is_one_added_event_with_the_reply_it_belongs_to(self):
        [event] = self.events(reaction(new=["👍"]))
        self.assertEqual(event, {
            "agentId": "agent-1", "telegramUserId": str(OPERATOR), "telegramChatId": str(OPERATOR),
            "telegramMessageId": 50, "emoji": "👍", "action": "added",
            "conversationId": CONV, "messageId": MSG,
        })

    def test_a_removed_reaction_is_a_removed_event(self):
        [event] = self.events(reaction(old=["👍"], new=[]))
        self.assertEqual((event["emoji"], event["action"]), ("👍", "removed"))

    def test_swapping_emoji_removes_the_old_one_first_and_keeps_unchanged_ones_quiet(self):
        events = self.events(reaction(old=["👍", "🔥"], new=["🔥", "👎"]))
        self.assertEqual([(e["emoji"], e["action"]) for e in events], [("👍", "removed"), ("👎", "added")])

    def test_picture_metadata_travels_with_the_event(self):
        [event] = self.events(reaction(new=["❤"]), target=dict(TARGET, picture={"fileId": FILE}))
        self.assertEqual(event["picture"], {"fileId": FILE})

    def test_foreign_and_unlinked_reactions_are_ignored(self):
        self.assertEqual(self.events(reaction(new=["👍"]), target=None), [])
        self.assertEqual(self.events(reaction(user_id=STRANGER, new=["👍"])), [])
        anonymous = reaction(new=["👍"])
        del anonymous["user"]
        self.assertEqual(self.events(anonymous), [])

    def test_custom_emoji_are_skipped(self):
        update = reaction(new=[])
        update["new_reaction"] = [{"type": "custom_emoji", "custom_emoji_id": "1"}]
        self.assertEqual(self.events(update), [])


class DispatchTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.patches = [mock.patch.object(bridge, "save_state"),
                        mock.patch.object(bridge, "cli_env", return_value={"ok": True})]
        _, self.cli_env = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def test_only_messages_we_sent_are_reported_and_the_event_goes_through_the_cli(self):
        bridge.remember_reaction_target(self.state, BOT["token"], OPERATOR, 50, TARGET)
        bridge.handle_updates(self.state, BOT["token"], BOT, [
            {"update_id": 1, "message_reaction": reaction(new=["👍"], message_id=50)},
            {"update_id": 2, "message_reaction": reaction(new=["👍"], message_id=51)},
            {"update_id": 3, "message_reaction": reaction(user_id=STRANGER, new=["👍"], message_id=50)},
        ])
        self.assertEqual(self.cli_env.call_count, 1)
        env, *parts = self.cli_env.call_args.args
        self.assertEqual(parts[:4], ["chat", "reaction", "-C", "company-1"])
        self.assertEqual(json.loads(env["TT"])["emoji"], "👍")

    def test_reactions_are_requested_from_telegram(self):
        self.assertIn("message_reaction", bridge.ALLOWED_UPDATES)

    def test_target_table_is_capped_oldest_first(self):
        with mock.patch.object(bridge, "REACTION_TARGET_LIMIT", 2):
            for i in (1, 2, 3):
                bridge.remember_reaction_target(self.state, BOT["token"], OPERATOR, i, TARGET)
        self.assertEqual(list(self.state["bots"][BOT["token"]]["reactionTargets"]), [f"{OPERATOR}:2", f"{OPERATOR}:3"])

    def test_send_plain_returns_message_ids(self):
        with mock.patch.object(bridge, "tg", return_value={"message_id": 77}):
            self.assertEqual(bridge.send_plain("t", 1, "hi"), [77])


class FollowUpTests(unittest.TestCase):
    """DUR-4345: one follow-up question per disliked picture, answered only by replying to it."""

    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.save = mock.patch.object(bridge, "save_state")
        self.save.start()

    def tearDown(self):
        self.save.stop()

    def dispatch(self, res):
        bridge.remember_reaction_target(self.state, BOT["token"], OPERATOR, 50, dict(TARGET, picture={"fileId": FILE}))
        with mock.patch.object(bridge, "cli_env", return_value=res) as cli, \
                mock.patch.object(bridge, "tg", return_value={"message_id": 60}) as tg:
            bridge.handle_updates(self.state, BOT["token"], BOT, [
                {"update_id": 1, "message_reaction": reaction(new=["👎"], message_id=50)}])
        return cli, tg

    def test_the_question_is_sent_as_a_reply_to_the_picture_when_the_server_offers_it(self):
        _, tg = self.dispatch({"ok": True, "followUp": {"text": "What should I change?"}})
        tg.assert_called_once()
        self.assertEqual(tg.call_args.args[:2], ("bot-token", "sendMessage"))
        self.assertEqual(tg.call_args.kwargs["text"], "What should I change?")
        self.assertEqual(tg.call_args.kwargs["reply_to_message_id"], 50)
        self.assertIn(f"{OPERATOR}:60", self.state["bots"][BOT["token"]]["reactionFollowUps"])

    def test_no_question_when_the_server_does_not_offer_one(self):
        _, tg = self.dispatch({"ok": True})
        tg.assert_not_called()
        self.assertNotIn("reactionFollowUps", self.state["bots"][BOT["token"]])

    def test_no_question_when_the_reaction_was_refused(self):
        _, tg = self.dispatch({"ok": False, "status": 409, "followUp": {"text": "x"}})
        tg.assert_not_called()

    def answer(self, text, user=OPERATOR, to=60):
        m = {"chat": {"id": OPERATOR, "type": "private"}, "from": {"id": user}, "text": text,
             "reply_to_message": {"message_id": to}}
        with mock.patch.object(bridge, "cli_env", return_value={"ok": True}) as cli:
            bridge.take_follow_up_answer(self.state, BOT, m, text)
        return cli

    def test_a_reply_to_the_question_is_the_answer_once(self):
        self.dispatch({"ok": True, "followUp": {"text": "q"}})
        cli = self.answer("too much text")
        env, *parts = cli.call_args.args
        self.assertIn("--follow-up-answer", parts)
        sent = json.loads(env["TT"])
        self.assertEqual((sent["answer"], sent["telegramMessageId"], sent["agentId"]), ("too much text", 50, "agent-1"))
        self.assertEqual(self.answer("and more").call_count, 0)

    def test_other_messages_are_never_taken_as_an_answer(self):
        self.dispatch({"ok": True, "followUp": {"text": "q"}})
        self.assertEqual(self.answer("hello", to=61).call_count, 0)
        self.assertEqual(self.answer("hello", user=STRANGER).call_count, 0)
        m = {"chat": {"id": OPERATOR}, "from": {"id": OPERATOR}, "text": "plain message"}
        with mock.patch.object(bridge, "cli_env") as cli:
            bridge.take_follow_up_answer(self.state, BOT, m, "plain message")
        cli.assert_not_called()


if __name__ == "__main__":
    unittest.main()
