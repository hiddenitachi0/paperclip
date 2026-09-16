#!/usr/bin/env python3
"""Where the Telegram bots come from, DUR-3978 slice 2
(run: python3 scripts/telegram-bridge-config.test.py).

Before this, the bots lived in a root-only JSON file on the production host and
adding one meant editing that file and restarting a service. These tests pin
that the bots now come from Paperclip, that the old file still works when
Paperclip does not answer, that a bot connected in the app starts answering
without a restart and a removed one stops, and that none of this widens who may
use a bot.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these against it (used to prove they fail on the code before this change).
"""
import importlib.util
import json
import os
import re
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_config", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
OPERATOR2 = 222222
STRANGER = 999999
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
AGENT1 = "a0000000-0000-4000-8000-000000000001"
AGENT2 = "a0000000-0000-4000-8000-000000000002"
TOKEN1 = "8100000001:AAHtestingtestingtestingtesting01"
TOKEN2 = "8100000002:AAHtestingtestingtestingtesting02"


def api_bot(agent_id=AGENT1, token=TOKEN1, name="CEO", company=COMPANY, allowed=()):
    return {
        "id": "b0000000-0000-4000-8000-000000000001",
        "agentId": agent_id,
        "name": name,
        "companyId": company,
        "uiBase": "https://paperclip.example",
        "allowedUserIds": list(allowed),
        "token": token,
    }


def file_bot(agent_id=AGENT2, token=TOKEN2, name="Fork Lead", company=COMPANY):
    return {"agentId": agent_id, "name": name, "token": token, "companyId": company}


def message(user_id, text="hello", chat_type="private", chat_id=None):
    return {"chat": {"id": chat_id if chat_id is not None else user_id, "type": chat_type},
            "from": {"id": user_id}, "text": text}


class ConfigTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False)
        self.tmp.write("[]")
        self.tmp.close()
        self.previous_config_file = bridge.CONFIG_FILE
        bridge.CONFIG_FILE = self.tmp.name
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        with bridge.LOCK:
            bridge.CURRENT_BOTS.clear()
        bridge.BOT_THREADS.clear()
        self.cli = mock.patch.object(bridge, "cli", return_value=None).start()

    def tearDown(self):
        mock.patch.stopall()
        bridge.CONFIG_FILE = self.previous_config_file
        os.unlink(self.tmp.name)

    def write_file_bots(self, bots):
        with open(self.tmp.name, "w") as f:
            json.dump(bots, f)


class ConfigSourceTests(ConfigTestCase):
    def test_the_bots_come_from_paperclip(self):
        self.cli.return_value = {"bots": [api_bot()]}

        bots = bridge.load_bots()

        self.cli.assert_called_once_with("telegram", "bridge-config")
        self.assertEqual([b["agentId"] for b in bots], [AGENT1])
        self.assertEqual(bots[0]["token"], TOKEN1)
        self.assertEqual(bots[0]["companyId"], COMPANY)
        self.assertEqual(bots[0]["source"], "paperclip")

    def test_when_paperclip_does_not_answer_the_file_keeps_the_bots_running(self):
        self.write_file_bots([file_bot()])
        self.cli.return_value = None

        bots = bridge.load_bots()

        self.assertEqual([b["agentId"] for b in bots], [AGENT2])
        self.assertEqual(bots[0]["source"], "file")

    def test_a_bot_only_in_the_file_keeps_working_alongside_the_ones_in_paperclip(self):
        self.write_file_bots([file_bot()])
        self.cli.return_value = {"bots": [api_bot()]}

        bots = bridge.load_bots()

        self.assertEqual(sorted(b["agentId"] for b in bots), sorted([AGENT1, AGENT2]))

    def test_paperclip_wins_for_an_agent_the_file_also_describes(self):
        self.write_file_bots([file_bot(agent_id=AGENT1, token="8100000009:AAHstaleoldtokenstaleoldtoken09")])
        self.cli.return_value = {"bots": [api_bot(agent_id=AGENT1, token=TOKEN1)]}

        bots = bridge.load_bots()

        self.assertEqual(len(bots), 1)
        self.assertEqual(bots[0]["token"], TOKEN1)

    def test_an_empty_answer_from_paperclip_is_an_answer_but_a_missing_one_is_not(self):
        self.write_file_bots([file_bot()])

        self.cli.return_value = {"bots": []}
        self.assertEqual([b["agentId"] for b in bridge.load_bots()], [AGENT2])

        self.cli.return_value = {"nonsense": True}
        self.assertEqual([b["agentId"] for b in bridge.load_bots()], [AGENT2])

    def test_a_bot_without_a_token_is_skipped_rather_than_started(self):
        self.cli.return_value = {"bots": [api_bot(), {"agentId": AGENT2, "name": "No token", "companyId": COMPANY}]}

        self.assertEqual([b["agentId"] for b in bridge.load_bots()], [AGENT1])


class RefreshTests(ConfigTestCase):
    def setUp(self):
        super().setUp()
        self.threads = []

        class FakeThread:
            def __init__(inner, target=None, args=(), daemon=None):
                inner.args = args
                inner.alive = False
                self.threads.append(inner)

            def start(inner):
                inner.alive = True

            def is_alive(inner):
                return inner.alive

        mock.patch.object(bridge.threading, "Thread", FakeThread).start()
        self.state = {"bots": {}, "notified": []}

    def started_tokens(self):
        return [t.args[1] for t in self.threads]

    def test_a_bot_connected_in_the_app_starts_answering_without_a_restart(self):
        self.cli.return_value = {"bots": [api_bot()]}
        bridge.refresh_bots(self.state)
        self.assertEqual(self.started_tokens(), [TOKEN1])

        # The operator connects a second bot; nobody restarts anything.
        self.cli.return_value = {"bots": [api_bot(), api_bot(agent_id=AGENT2, token=TOKEN2, name="Fork Lead")]}
        bridge.refresh_bots(self.state)

        self.assertEqual(self.started_tokens(), [TOKEN1, TOKEN2])
        self.assertIsNotNone(bridge.current_bot(TOKEN2))

    def test_a_removed_bot_stops_being_served(self):
        self.cli.return_value = {"bots": [api_bot(), api_bot(agent_id=AGENT2, token=TOKEN2, name="Fork Lead")]}
        bridge.refresh_bots(self.state)
        self.assertIsNotNone(bridge.current_bot(TOKEN2))

        self.cli.return_value = {"bots": [api_bot()]}
        bots = bridge.refresh_bots(self.state)

        self.assertEqual([b["token"] for b in bots], [TOKEN1])
        # Gone from the live set: the thread's next pass sees None and returns.
        self.assertIsNone(bridge.current_bot(TOKEN2))
        self.assertNotIn(TOKEN2, bridge.BOT_THREADS)
        # And no thread was started again for it.
        self.assertEqual(self.started_tokens(), [TOKEN1, TOKEN2])

    def test_a_running_bot_is_not_started_twice(self):
        self.cli.return_value = {"bots": [api_bot()]}
        bridge.refresh_bots(self.state)
        bridge.refresh_bots(self.state)

        self.assertEqual(self.started_tokens(), [TOKEN1])


class AllowlistFromTheApiTests(ConfigTestCase):
    def setUp(self):
        super().setUp()
        self.state = {"bots": {TOKEN1: {"offset": 0, "chats": [OPERATOR, OPERATOR2]}}, "notified": []}
        self.tg = mock.patch.object(bridge, "tg", return_value={}).start()
        self.cli_env = mock.patch.object(bridge, "cli_env", return_value={"ok": True, "lane": "a",
                                                                          "result": {"response": "ok"}}).start()
        mock.patch.object(bridge, "save_state").start()

    def bot_with(self, allowed):
        self.cli.return_value = {"bots": [api_bot(allowed=allowed)]}
        return bridge.load_bots()[0]

    def test_the_people_the_operator_added_are_the_ones_who_get_in(self):
        bot = self.bot_with(["222222"])

        self.assertEqual(bridge.allowed_users_for(bot), {OPERATOR2})

    def test_someone_not_on_a_bots_list_is_refused_even_when_allowed_elsewhere(self):
        bot = self.bot_with(["222222"])

        bridge.handle_message(self.state, bot, message(OPERATOR, "what is our cash?"))

        self.cli_env.assert_not_called()
        self.tg.assert_not_called()

    def test_someone_on_the_bots_list_gets_through(self):
        bot = self.bot_with(["222222"])

        bridge.handle_message(self.state, bot, message(OPERATOR2, "what is our cash?"))

        self.cli_env.assert_called_once()

    def test_a_bot_with_nobody_added_falls_back_to_the_instance_wide_list(self):
        bot = self.bot_with([])

        self.assertEqual(bridge.allowed_users_for(bot), {OPERATOR})

    def test_with_no_list_anywhere_nobody_gets_in(self):
        bridge.ALLOWED_USER_IDS = set()
        bot = self.bot_with([])

        self.assertEqual(bridge.allowed_users_for(bot), set())
        bridge.handle_message(self.state, bot, message(OPERATOR, "hello"))
        self.cli_env.assert_not_called()

    def test_a_group_chat_is_still_refused_whatever_the_list_says(self):
        bot = self.bot_with(["111111"])

        bridge.handle_message(self.state, bot, message(OPERATOR, "hello", chat_type="group", chat_id=-100200))

        self.cli_env.assert_not_called()

    def test_a_damaged_id_in_the_list_never_becomes_a_wildcard(self):
        bot = self.bot_with(["not-an-id", "", "222222"])

        self.assertEqual(bridge.allowed_users_for(bot), {OPERATOR2})

    def test_cards_only_reach_the_people_on_that_bots_list(self):
        bot = self.bot_with(["222222"])

        chats = bridge.deliverable_chats(self.state, bot["token"], bridge.allowed_users_for(bot))

        self.assertEqual(chats, [OPERATOR2])

    def test_a_button_tap_from_someone_not_on_the_bots_list_does_nothing(self):
        bot = self.bot_with(["222222"])

        bridge.handle_callback({"id": "cq-1", "_token": bot["token"], "_allowed": bridge.allowed_users_for(bot),
                                "from": {"id": OPERATOR}, "data": "approve:9abd6c8e-4c1d-40e7-a81e-73d1481c25ef",
                                "message": {"message_id": 5, "chat": {"id": OPERATOR}, "text": "Deploy"}})

        self.cli.assert_called_once_with("telegram", "bridge-config")  # only the config call, no approval


class SharedContractTests(unittest.TestCase):
    """The bridge, the CLI and the server must agree on names nothing else
    enforces — the recurring bug this codebase keeps hitting."""

    def read(self, *path):
        with open(os.path.join(REPO, *path)) as f:
            return f.read()

    def test_the_cli_command_the_bridge_calls_exists_and_is_registered(self):
        src = self.read("cli", "src", "commands", "client", "telegram.ts")
        self.assertIn('.command("telegram")', src)
        self.assertIn('.command("bridge-config")', src)
        self.assertIn("registerTelegramCommands(program)", self.read("cli", "src", "index.ts"))

    def test_the_routes_the_cli_calls_exist_on_the_server(self):
        cli_src = self.read("cli", "src", "commands", "client", "telegram.ts")
        routes_src = self.read("server", "src", "routes", "telegram-bots.ts")
        self.assertIn("/api/instance/telegram-bridge-config", cli_src)
        self.assertIn('"/instance/telegram-bridge-config"', routes_src)
        self.assertIn("/telegram-bots/${bot.id}/bridge-token", cli_src)
        self.assertIn('"/companies/:companyId/telegram-bots/:botId/bridge-token"', routes_src)

    def test_the_token_route_is_instance_admin_only(self):
        routes_src = self.read("server", "src", "routes", "telegram-bots.ts")
        block = routes_src.split('"/companies/:companyId/telegram-bots/:botId/bridge-token"')[1][:400]
        self.assertIn("assertInstanceAdmin", block)

    def test_the_fields_the_bridge_reads_are_the_fields_the_server_sends(self):
        types_src = self.read("packages", "shared", "src", "types", "telegram-bot.ts")
        block = re.search(r"export type TelegramBridgeBot = \{(.*?)\};", types_src, re.S).group(1)
        for field in ("agentId", "name", "companyId", "uiBase", "allowedUserIds", "token"):
            self.assertIn(field, block)


if __name__ == "__main__":
    unittest.main(verbosity=2)
