#!/usr/bin/env python3
"""Company isolation in the Telegram bridge (isolation audit, Oct 2026)
(run: python3 scripts/telegram-bridge-isolation.test.py).

1. Allow-lists are per bot. Before, a bot with an empty list fell back to the
   instance-wide list (TELEGRAM_ALLOWED_USER_IDS, or every private chat that
   ever wrote to ANY bot), so someone allowed on a Durkan bot could use a
   Nordstrand bot, read its data and tap its Approve buttons (board rights).
   Now there is no fallback. The one-time move keeps, for each bot without a
   list, only the old-list people who had already used THAT bot, logs it, and
   stores it so it is not redone.
2. No hard-coded company. A bot with no company configured is not started,
   with one clear log line.
"""
import contextlib
import importlib.util
import io
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")


def load_bridge(env=None):
    with mock.patch.dict(os.environ, env or {}, clear=False):
        if not env or "PAPERCLIP_COMPANY_ID" not in env:
            os.environ.pop("PAPERCLIP_COMPANY_ID", None)
        spec = importlib.util.spec_from_file_location("telegram_bridge_isolation", BRIDGE_PATH)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    return module


bridge = load_bridge()

DURKAN = "c0000000-0000-4000-8000-00000000000d"
NORDSTRAND = "c0000000-0000-4000-8000-00000000000e"
FILIP = 111111      # used both bots
DURKAN_ONLY = 222222  # only ever wrote to the Durkan bot
APPROVAL_ID = "9abd6c8e-4c1d-40e7-a81e-73d1481c25ef"
DURKAN_BOT = {"token": "durkan-token", "agentId": "a1", "name": "CEO", "companyId": DURKAN,
              "uiBase": "https://p.example", "allowedUserIds": set()}
NORD_BOT = {"token": "nord-token", "agentId": "a2", "name": "Daglig leder", "companyId": NORDSTRAND,
            "uiBase": "https://p.example", "allowedUserIds": set()}
OWN_LIST_BOT = {"token": "own-token", "agentId": "a3", "name": "Fork Lead", "companyId": DURKAN,
                "uiBase": "https://p.example", "allowedUserIds": {333333}}


def message(user_id, text="hello"):
    return {"chat": {"id": user_id, "type": "private"}, "from": {"id": user_id}, "text": text}


class Base(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {
            DURKAN_BOT["token"]: {"offset": 0, "chats": [FILIP, DURKAN_ONLY]},
            NORD_BOT["token"]: {"offset": 0, "chats": [FILIP]},
            OWN_LIST_BOT["token"]: {"offset": 0, "chats": [FILIP, 333333]},
        }, "notified": []}
        bridge.LEGACY_ALLOWED_BY_TOKEN = {}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "cli", return_value={"ok": True}),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="x"),
        ]
        self.tg, self.cli, self.cli_env, self.save, _, _ = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def migrate(self, env_value=""):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            kept = bridge.migrate_legacy_allowlists(self.state, [DURKAN_BOT, NORD_BOT, OWN_LIST_BOT], env_value)
        bridge.LEGACY_ALLOWED_BY_TOKEN = kept
        return kept, out.getvalue()


class PerBotAllowListTests(Base):
    def test_a_person_allowed_on_one_companys_bot_is_not_allowed_on_anothers(self):
        self.migrate()

        self.assertIn(DURKAN_ONLY, bridge.allowed_users_for(DURKAN_BOT))
        self.assertNotIn(DURKAN_ONLY, bridge.allowed_users_for(NORD_BOT))

        bridge.handle_message(self.state, NORD_BOT, message(DURKAN_ONLY, "what are Nordstrand's sales?"))
        self.cli_env.assert_not_called()
        self.cli.assert_not_called()
        self.assertNotIn(DURKAN_ONLY, self.state["bots"][NORD_BOT["token"]]["chats"])

    def test_they_cannot_tap_approve_on_the_other_companys_bot(self):
        self.migrate()
        bridge.handle_callback({"id": "cq", "_token": NORD_BOT["token"], "from": {"id": DURKAN_ONLY},
                                "_allowed": bridge.allowed_users_for(NORD_BOT),
                                "data": f"approve:{APPROVAL_ID}",
                                "message": {"message_id": 5, "chat": {"id": DURKAN_ONLY}, "text": "Deploy"}})
        self.cli.assert_not_called()

    def test_no_cards_go_to_people_from_another_companys_bot(self):
        self.migrate()
        self.state["bots"][NORD_BOT["token"]]["chats"].append(DURKAN_ONLY)  # however it got there
        chats = bridge.deliverable_chats(self.state, NORD_BOT["token"], bridge.allowed_users_for(NORD_BOT))
        self.assertEqual(chats, [FILIP])

    def test_the_old_env_list_is_not_a_fallback_any_more(self):
        kept, _ = self.migrate(env_value=f"{FILIP},{DURKAN_ONLY},444444")
        # 444444 never used any bot: kept nowhere.
        self.assertEqual(kept[NORD_BOT["token"]], {FILIP})
        self.assertEqual(kept[DURKAN_BOT["token"]], {FILIP, DURKAN_ONLY})
        self.assertFalse(any(444444 in ids for ids in kept.values()))

    def test_a_bot_with_its_own_list_uses_only_that_list(self):
        self.migrate()
        self.assertEqual(bridge.allowed_users_for(OWN_LIST_BOT), {333333})
        self.assertNotIn(OWN_LIST_BOT["token"], bridge.LEGACY_ALLOWED_BY_TOKEN)

    def test_a_bot_connected_after_the_move_starts_with_nobody(self):
        self.migrate()
        new_bot = dict(NORD_BOT, token="new-token", name="New")
        self.assertEqual(bridge.allowed_users_for(new_bot), set())

    def test_without_a_move_nobody_is_allowed_on_a_bot_without_a_list(self):
        self.assertEqual(bridge.allowed_users_for(DURKAN_BOT), set())


class MigrationTests(Base):
    def test_the_move_keeps_only_people_who_used_that_bot_and_logs_it(self):
        kept, log = self.migrate()

        self.assertEqual(kept, {DURKAN_BOT["token"]: {FILIP, DURKAN_ONLY}, NORD_BOT["token"]: {FILIP}})
        self.assertIn("CEO", log)
        self.assertIn("Daglig leder", log)
        self.assertIn(str(DURKAN_ONLY), log)
        self.assertIn("no longer allowed", log)
        self.assertEqual(self.state["legacy_allowed"],
                         {DURKAN_BOT["token"]: [FILIP, DURKAN_ONLY], NORD_BOT["token"]: [FILIP]})
        self.save.assert_called()

    def test_the_move_happens_once(self):
        self.migrate()
        # Somebody new writes to the Durkan bot later (and is refused); the
        # next start reads the stored result instead of redoing the move.
        self.state["bots"][NORD_BOT["token"]]["chats"].append(DURKAN_ONLY)
        kept, log = self.migrate()
        self.assertEqual(kept[NORD_BOT["token"]], {FILIP})
        self.assertEqual(log, "")

    def test_nothing_is_stored_while_paperclip_has_not_answered(self):
        with contextlib.redirect_stdout(io.StringIO()):
            bridge.migrate_legacy_allowlists(self.state, [DURKAN_BOT], "", persist=False)
        self.assertNotIn("legacy_allowed", self.state)


class NoHardCodedCompanyTests(unittest.TestCase):
    def test_there_is_no_built_in_company(self):
        self.assertIsNone(bridge.DEFAULT_COMPANY_ID)
        with open(BRIDGE_PATH) as source:
            self.assertNotIn("7600f03c-c836-4326-8d48-c801813c3a87", source.read())

    def test_a_paperclip_bot_without_a_company_is_not_started_and_says_so_once(self):
        roster = {"bots": [
            {"id": "b1", "agentId": "a1", "name": "Orphan", "token": "t1"},
            {"id": "b2", "agentId": "a2", "name": "Fine", "token": "t2", "companyId": NORDSTRAND},
        ]}
        bridge.REFUSED_NO_COMPANY.clear()
        out = io.StringIO()
        with mock.patch.object(bridge, "cli", return_value=roster), contextlib.redirect_stdout(out):
            first = bridge.fetch_bots_from_api()
            bridge.fetch_bots_from_api()
        self.assertEqual([b["name"] for b in first], ["Fine"])
        self.assertEqual(out.getvalue().count("not starting Orphan: no company is configured"), 1)

    def test_a_file_bot_without_a_company_is_not_started(self):
        bridge.REFUSED_NO_COMPANY.clear()
        out = io.StringIO()
        content = '[{"agentId": "a1", "name": "Old", "token": "t1"}, {"agentId": "a2", "name": "Named", "token": "t2", "companyId": "%s"}]' % DURKAN
        with mock.patch("builtins.open", mock.mock_open(read_data=content)), contextlib.redirect_stdout(out):
            bots = bridge.load_file_bots()
        self.assertEqual([b["name"] for b in bots], ["Named"])
        self.assertIn("not starting Old", out.getvalue())

    def test_an_explicit_setting_still_names_the_company_for_old_file_bots(self):
        configured = load_bridge({"PAPERCLIP_COMPANY_ID": NORDSTRAND})
        content = '[{"agentId": "a1", "name": "Old", "token": "t1"}]'
        with mock.patch("builtins.open", mock.mock_open(read_data=content)):
            bots = configured.load_file_bots()
        self.assertEqual(bots[0]["companyId"], NORDSTRAND)


if __name__ == "__main__":
    unittest.main()
