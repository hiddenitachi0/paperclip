#!/usr/bin/env python3
"""Morning reports (run: python3 scripts/telegram-bridge-morning-report.test.py).

A quick agent with a morning report writes it at its set time and Paperclip
puts it in the morning-report outbox. The bridge sends each report through the
agent's own bot (or its boss's), into allowed private chats only, once, and
acknowledges it. These tests pin that:

  - a report goes to the agent's own bot, allowed chats only, and is acknowledged;
  - a report is sent once: a lost acknowledgement is repeated without sending again;
  - nothing is acknowledged when nobody could receive it or Telegram refused;
  - an agent without a bot of its own reports through its boss's bot;
  - a report of another company in the answer is ignored;
  - a long report (no facts — written before DUR-4059) is split into several messages.

DUR-4059 direction change: a report with structured facts becomes exactly ONE
Telegram message — the weather picture (if Media Studio made one) with a
short plain-text caption (facts['teaser']) and the briefing-page link, only
once that page is live. These tests additionally pin that:

  - a report with facts sends its teaser as ONE photo caption (not the long
    written text, not separate HTML section messages) when a weather picture
    exists;
  - the briefing-page link is appended only when facts['briefingPageLive'] is
    true, and left off otherwise (DUR-4075 not live yet);
  - no weather picture (Media Studio failed, or none was requested) sends the
    same teaser as a single plain text message instead, never losing the report;
  - the mood picture, if present, is never sent to Telegram (it is page-only);
  - the chat is pointed at the report's conversationId so a later reply
    continues the same history;
  - a report with no facts (written before DUR-4059) behaves exactly as
    before — the full written text, split if long, no photos.
"""
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_morning_report", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
STRANGER = 999999
COMPANY = "c0000000-0000-4000-8000-000000000001"
OTHER_COMPANY = "c0000000-0000-4000-8000-000000000002"
MAJA = "a0000000-0000-4000-8000-000000000001"
BOSS = "a0000000-0000-4000-8000-000000000002"
HELPER = "a0000000-0000-4000-8000-000000000003"
REPORT1 = "d0000000-0000-4000-8000-000000000001"
REPORT2 = "d0000000-0000-4000-8000-000000000002"

MAJA_BOT = {"token": "maja-token", "agentId": MAJA, "name": "Maja", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}
BOSS_BOT = {"token": "boss-token", "agentId": BOSS, "name": "Boss", "companyId": COMPANY,
            "uiBase": "https://paperclip.example", "allowedUserIds": {OPERATOR}}

TEXT = "Good morning!\n\nWeather: Drobak 12C, light rain. Oslo 11C.\n\nHeadlines: ..."
TEASER = "Drøbak: 12C, light rain; Oslo: 11C\nTop story: Big <news> today & more\nBTC: 65000 USD (+1.23%)"
CONV = "e0000000-0000-4000-8000-000000000001"
WEATHER_FILE = "f0000000-0000-4000-8000-000000000001"
MOOD_FILE = "f0000000-0000-4000-8000-000000000002"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes"

FACTS = {
    "places": ["Drøbak", "Oslo"],
    "weather": [{"place": "Drøbak", "text": "Now in Drøbak: light rain, 12°C"},
                {"place": "Oslo", "text": "Now in Oslo: cloudy, 11°C"}],
    "headlines": [
        {"title": "Big <news> today & more", "url": "https://example.com/a", "source": "nrk"},
    ],
    "hobby": [],
    "sport": [{"title": "Zucc scores again", "url": "https://example.com/sport", "source": "mats_zuccarello_nhl"}],
    "prices": [
        {"symbol": "BTC", "price": 65000, "currency": "USD", "changePercent": 1.2345, "history": []},
    ],
    "images": [
        {"fileId": WEATHER_FILE, "caption": "Maja, dressed for today's weather.", "kind": "weather"},
        {"fileId": MOOD_FILE, "caption": "Today's mood, in one picture.", "kind": "mood"},
    ],
    "opening": "Good morning! A busy news day.",
    "teaser": TEASER,
    "stats": {"sourcesChecked": 1, "itemsFound": 1},
    "briefingPageLive": True,
    "notes": [],
}


def report(report_id=REPORT1, agent=MAJA, text=TEXT, company=COMPANY, facts=None, conversation_id=None):
    item = {"id": report_id, "companyId": company, "agentId": agent, "text": text,
            "createdAt": "2026-09-29T05:00:00.000Z"}
    if facts is not None:
        item["facts"] = facts
    if conversation_id is not None:
        item["conversationId"] = conversation_id
    return item


def picture(data=JPEG, content_type="image/jpeg"):
    import base64
    return {"ok": True, "contentType": content_type, "byteSize": len(data),
            "contentBase64": base64.b64encode(data).decode()}


class MorningReportTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {MAJA_BOT["token"]: {"offset": 0, "chats": [OPERATOR, STRANGER]},
                               BOSS_BOT["token"]: {"offset": 0, "chats": [OPERATOR]}},
                      "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.outbox = {COMPANY: [report()]}
        self.acks = []
        self.pictures = {WEATHER_FILE: picture(), MOOD_FILE: picture()}

        def fake_cli(*parts):
            if parts[:2] == ("morning-report", "outbox"):
                return {"reports": list(self.outbox.get(parts[3], []))}
            if parts[:2] == ("morning-report", "outbox:ack"):
                self.acks.append((parts[2], parts[4], parts[6]))
                return {"id": parts[2], "status": "delivered"}
            if parts[:2] == ("chat", "image"):
                return self.pictures.get(parts[2])
            if parts[:2] == ("agent", "list"):
                return [{"id": MAJA, "reportsTo": BOSS, "name": "Maja", "role": "general"},
                        {"id": BOSS, "reportsTo": None, "name": "Boss", "role": "ceo"},
                        {"id": HELPER, "reportsTo": BOSS, "name": "Helper", "role": "general"}]
            return None

        self.patches = [
            mock.patch.object(bridge, "tg", return_value={"message_id": 1}),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 2}),
            mock.patch.object(bridge, "cli", side_effect=fake_cli),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.tg_upload, self.cli, self.save = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def run_pass(self, bots=None):
        bridge.notify_morning_reports(self.state, bots or [MAJA_BOT, BOSS_BOT])

    def sent_texts(self):
        return [(c.args[0], c.kwargs["chat_id"], c.kwargs["text"]) for c in self.tg.call_args_list
                if c.args[1] == "sendMessage" and c.kwargs.get("parse_mode") != "HTML"]

    def sent_html(self):
        return [(c.args[0], c.kwargs["chat_id"], c.kwargs["text"]) for c in self.tg.call_args_list
                if c.args[1] == "sendMessage" and c.kwargs.get("parse_mode") == "HTML"]

    def sent_photos(self):
        return [(c.args[0], c.kwargs["chat_id"], c.kwargs.get("caption")) for c in self.tg_upload.call_args_list
                if c.args[1] == "sendPhoto"]

    def test_the_report_goes_through_the_agents_own_bot_to_allowed_chats_and_is_acknowledged(self):
        self.run_pass()
        self.assertEqual(self.sent_texts(), [("maja-token", OPERATOR, TEXT)])
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])
        self.assertEqual(self.state["sent_morning_reports"], [REPORT1])

    def test_a_lost_acknowledgement_is_repeated_without_sending_again(self):
        self.state["sent_morning_reports"] = [REPORT1]
        self.run_pass()
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])

    def test_nothing_is_acknowledged_when_nobody_started_the_bot(self):
        self.state["bots"][MAJA_BOT["token"]]["chats"] = []
        self.run_pass([MAJA_BOT])
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.acks, [])

    def test_nothing_is_acknowledged_when_telegram_refused(self):
        self.tg.return_value = None
        self.run_pass()
        self.assertEqual(self.acks, [])
        self.assertNotIn(REPORT1, self.state.get("sent_morning_reports", []))

    def test_an_agent_without_its_own_bot_reports_through_its_boss(self):
        self.outbox[COMPANY] = [report(agent=HELPER)]
        self.run_pass()
        texts = self.sent_texts()
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0][0], "boss-token")
        self.assertIn("on behalf of Helper", texts[0][2])

    def test_a_report_of_another_company_is_ignored(self):
        self.outbox[COMPANY] = [report(company=OTHER_COMPANY), report(REPORT2)]
        self.run_pass()
        self.assertEqual(self.acks, [(REPORT2, COMPANY, "delivered")])

    def test_a_long_report_with_no_facts_is_split(self):
        self.outbox[COMPANY] = [report(text="News line. " * 900)]
        self.run_pass()
        self.assertGreater(len(self.sent_texts()), 1)
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])

    # ─── DUR-4059 direction change: ONE message — picture + teaser + link ──

    def test_a_report_with_no_facts_behaves_exactly_as_before(self):
        self.run_pass()
        self.assertEqual(self.sent_texts(), [("maja-token", OPERATOR, TEXT)])
        self.assertEqual(self.sent_html(), [])
        self.tg_upload.assert_not_called()

    def test_facts_with_a_weather_picture_send_it_as_one_photo_with_the_teaser_and_link_as_its_caption(self):
        self.outbox[COMPANY] = [report(facts=FACTS, conversation_id=CONV)]
        self.run_pass()

        # Exactly one photo per allowed chat, no separate text or HTML messages.
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.sent_html(), [])
        photos = self.sent_photos()
        self.assertEqual(len(photos), 1)
        token, chat_id, caption = photos[0]
        self.assertEqual(token, "maja-token")
        self.assertEqual(chat_id, OPERATOR)
        self.assertTrue(caption.startswith(TEASER))
        self.assertIn(f"Full briefing: https://paperclip.example/agents/{MAJA}/morning-reports/{REPORT1}", caption)
        # The teaser is plain text: an HTML-looking fragment from a headline
        # title is never turned into a link or any other markup.
        self.assertIn("<news>", caption)
        self.assertNotIn("<a href", caption)

        # Only the weather picture is ever sent — the mood picture stays page-only.
        upload_args = self.tg_upload.call_args_list[0]
        self.assertIn(f"report-{WEATHER_FILE[:8]}", upload_args.args[3])

        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])
        self.assertEqual(bridge.get_conversation(self.state, "maja-token", OPERATOR), CONV)

    def test_the_briefing_link_is_left_off_until_the_page_is_live(self):
        facts = {**FACTS, "briefingPageLive": False}
        self.outbox[COMPANY] = [report(facts=facts)]
        self.run_pass()

        caption = self.sent_photos()[0][2]
        self.assertEqual(caption, TEASER)
        self.assertNotIn("Full briefing", caption)

    def test_no_weather_picture_sends_the_teaser_as_plain_text_instead(self):
        facts = {**FACTS, "images": [im for im in FACTS["images"] if im["kind"] != "weather"]}
        self.outbox[COMPANY] = [report(facts=facts)]
        self.run_pass()

        self.tg_upload.assert_not_called()
        texts = self.sent_texts()
        self.assertEqual(len(texts), 1)
        self.assertEqual(texts[0][0], "maja-token")
        self.assertIn(TEASER, texts[0][2])
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])

    def test_a_picture_that_cannot_be_fetched_falls_back_to_plain_text(self):
        self.pictures = {}  # neither fileId resolves
        self.outbox[COMPANY] = [report(facts=FACTS)]
        self.run_pass()
        self.tg_upload.assert_not_called()
        self.assertEqual(len(self.sent_texts()), 1)
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])

    def test_facts_are_sent_once_a_lost_acknowledgement_is_not_resent(self):
        self.outbox[COMPANY] = [report(facts=FACTS, conversation_id=CONV)]
        self.state["sent_morning_reports"] = [REPORT1]
        self.run_pass()
        self.assertEqual(self.sent_texts(), [])
        self.assertEqual(self.sent_photos(), [])
        self.tg_upload.assert_not_called()
        self.assertEqual(self.acks, [(REPORT1, COMPANY, "delivered")])


if __name__ == "__main__":
    unittest.main()
