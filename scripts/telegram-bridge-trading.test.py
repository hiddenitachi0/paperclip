#!/usr/bin/env python3
"""/trading, /pause, /resume -- the trading agent's kill switch over Telegram
(run: python3 scripts/telegram-bridge-trading.test.py).

DUR-4171's ground rule is "kill switch in UI and Telegram" for the trading
agent's paper-trading strategies. /pause takes no strategy id on purpose (a
kill switch has to work even when the operator can't recall one under
pressure) and stops every running strategy for the company. /resume always
names one, since a strategy the risk gate halted needs a deliberate look
before it trades again -- and because that id is free text typed into
Telegram, these tests pin that it reaches the CLI only as data in an
environment variable, never interpolated into the shell command string (the
same property telegram-bridge-cont.test.py pins for /cont).
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_trading", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
STRATEGY = "e0000000-0000-4000-8000-000000000001"


def message(text, user_id=OPERATOR):
    return {"chat": {"id": user_id, "type": "private"}, "from": {"id": user_id}, "text": text}


def strategy_row(strategy_id=STRATEGY, name="BTC rule v1", asset="BTC/USDT", status="running", pause_reason=None):
    return {"id": strategy_id, "name": name, "asset": asset, "status": status, "pauseReason": pause_reason}


class BridgeTradingTestCase(unittest.TestCase):
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


class TradingListTests(BridgeTradingTestCase):
    def test_lists_id_name_asset_status_and_pause_reason(self):
        self.cli.return_value = [strategy_row(), strategy_row("e0000000-0000-4000-8000-000000000002",
                                                                "ETH rule v1", "ETH/USDT", "paused", "manual")]
        bridge.handle_message(self.state, BOT, message("/trading"))
        self.cli.assert_called_once_with("trading", "list", "-C", COMPANY)
        text = self.texts()[0]
        self.assertIn(STRATEGY, text)
        self.assertIn("BTC rule v1", text)
        self.assertIn("running", text)
        self.assertIn("ETH rule v1 (ETH/USDT) — paused (manual)", text)

    def test_no_strategies_is_said_plainly(self):
        self.cli.return_value = []
        bridge.handle_message(self.state, BOT, message("/trading"))
        self.assertEqual(self.texts(), ["No trading strategies configured yet."])


class PauseTests(BridgeTradingTestCase):
    def test_pause_needs_no_strategy_id_and_reports_what_it_stopped(self):
        self.cli.return_value = [strategy_row(status="paused", pause_reason="manual"),
                                  strategy_row("e0000000-0000-4000-8000-000000000002", "ETH rule v1",
                                               status="paused", pause_reason="manual")]
        bridge.handle_message(self.state, BOT, message("/pause"))
        self.cli.assert_called_once_with("trading", "pause-all", "-C", COMPANY)
        self.assertEqual(self.texts(), ["⏸ Paused: BTC rule v1, ETH rule v1"])

    def test_nothing_running_is_said_plainly(self):
        self.cli.return_value = []
        bridge.handle_message(self.state, BOT, message("/pause"))
        self.assertEqual(self.texts(), ["Nothing was running — no strategy to pause."])

    def test_unreachable_trading_agent_does_not_claim_success(self):
        self.cli.return_value = None
        bridge.handle_message(self.state, BOT, message("/pause"))
        self.assertEqual(self.texts(), ["Couldn't reach the trading agent — nothing was paused."])


class ResumeTests(BridgeTradingTestCase):
    def test_resume_passes_the_strategy_id_only_as_data_never_in_the_shell_string(self):
        self.cli_env.return_value = strategy_row(status="running")

        bridge.handle_message(self.state, BOT, message(f"/resume {STRATEGY}; rm -rf /"))

        env, parts = self.cli_env.call_args.args[0], self.cli_env.call_args.args[1:]
        self.assertEqual(env, {"SID": f"{STRATEGY}; rm -rf /"})
        self.assertEqual(parts, ("trading", "status", '"$SID"', "-C", COMPANY, "--status", "running"))
        self.assertNotIn("rm -rf", " ".join(parts))
        self.assertEqual(self.texts(), ["▶️ Resumed BTC rule v1."])

    def test_resume_without_an_id_shows_usage_and_calls_nothing(self):
        bridge.handle_message(self.state, BOT, message("/resume"))
        self.cli_env.assert_not_called()
        self.assertIn("Usage:", self.texts()[0])

    def test_resume_of_an_unknown_id_does_not_claim_success(self):
        self.cli_env.return_value = None
        bridge.handle_message(self.state, BOT, message(f"/resume {STRATEGY}"))
        self.assertIn("Couldn't resume", self.texts()[0])


class HelpAndCliSourceTests(BridgeTradingTestCase):
    def test_help_documents_the_new_commands(self):
        bridge.handle_message(self.state, BOT, message("/help"))
        text = self.texts()[0]
        for needle in ("/trading", "/pause", "/resume <strategy id>"):
            self.assertIn(needle, text)

    def test_the_cli_commands_the_bridge_uses_exist(self):
        with open(os.path.join(REPO, "cli", "src", "commands", "client", "trading.ts")) as f:
            cli_src = f.read()
        for needle in ('.command("list")', '.command("status")', '.command("pause-all")', 'registerTradingCommands'):
            self.assertIn(needle, cli_src)
        with open(os.path.join(REPO, "cli", "src", "index.ts")) as f:
            index_src = f.read()
        self.assertIn("registerTradingCommands(program)", index_src)

    def test_existing_commands_still_work(self):
        self.cli.side_effect = [[], []]
        bridge.handle_message(self.state, BOT, message("/status"))
        self.assertTrue(any(t.startswith("*Now:*") for t in self.texts()))


if __name__ == "__main__":
    unittest.main()
