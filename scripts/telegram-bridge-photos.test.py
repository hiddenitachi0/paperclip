#!/usr/bin/env python3
"""Photos sent to a bot, and messages the bridge cannot open
(run: python3 scripts/telegram-bridge-photos.test.py).

10 Oct: Filip sent Maja a photo of a friend in a kitchen with the caption
"alter this image to show you helping him prepare the meat on the counter",
and nothing happened: the bridge only read `text`, a photo's words are in
`caption`, so the message was dropped without a word. These tests pin:
  - a photo with a caption: the largest size is downloaded, stored in the
    bot's company's Files (`chat attach`, base64 on standard input), and the
    caption goes to the agent with the photo attached (`chat send
    --attachment <fileId>`);
  - a picture sent as a file (JPEG/PNG/WebP) is handled the same way;
  - a photo without a caption: the bridge asks what to do, and the next
    message goes with the photo;
  - a photo over 10 MB is refused in plain words without being downloaded;
  - a sticker, a video, another kind of file, a location: one plain sentence;
  - every received message is logged with time, bot, chat and kind, never
    its text, and a dropped one with the reason;
  - a linked person on the people bot sends the photo WITH the question
    (`telegram people-ask --picture-stdin`), so Paperclip stores it only
    after checking who they are; pictures in the answer are sent back;
  - the bot token never appears in a log line.
Nothing real is called: Telegram, the download and Paperclip are fakes.
"""
import base64
import contextlib
import importlib.util
import io
import os
import re
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_photos", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
ORIGINAL_TG = bridge.tg

OPERATOR = 111111
PERSON = 333333
STRANGER = 444444
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT_ID = "b0000000-0000-4000-8000-000000000001"
CONV = "d0000000-0000-4000-8000-000000000001"
FILE_ID = "e0000000-0000-4000-8000-000000000001"
MADE_ID = "e0000000-0000-4000-8000-000000000002"
JPEG = b"\xff\xd8\xff\xe0fake-kitchen-photo"
CAPTION = ("I have a friend helping us in his kitchen, alter this image to show you helping him "
           "prepare the meat on the counter")
TOKEN = "123456:secret-bot-token"


def make_bot(**extra):
    bot = {"token": TOKEN, "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
           "companyId": COMPANY, "uiBase": "https://paperclip.example", "botId": BOT_ID,
           "allowedUserIds": {OPERATOR}}
    bot.update(extra)
    return bot


def photo_message(sender=OPERATOR, caption=None, sizes=None):
    m = {"chat": {"id": sender, "type": "private"}, "from": {"id": sender},
         "photo": sizes or [
             {"file_id": "small", "file_size": 1200, "width": 90, "height": 60},
             {"file_id": "large", "file_size": 98000, "width": 1280, "height": 853},
             {"file_id": "medium", "file_size": 24000, "width": 320, "height": 213},
         ]}
    if caption is not None:
        m["caption"] = caption
    return m


def text_message(text, sender=OPERATOR):
    return {"chat": {"id": sender, "type": "private"}, "from": {"id": sender}, "text": text}


class FakeDownload(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class Base(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {TOKEN: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        bridge.legacy_allowed = lambda token: set()
        bridge.PENDING_PHOTOS.clear()
        bridge.PEOPLE_UNLINKED_UNTIL.clear()
        bridge.PEOPLE_FRESH.clear()
        self.answer = "Here you go: me and your friend at the counter."
        self.attach_result = {"ok": True, "fileId": FILE_ID, "contentType": "image/jpeg", "byteSize": len(JPEG)}
        self.people_result = {"ok": True, "outcome": "answered", "reply": "Done, here it is.", "requestId": "r1",
                              "images": [{"fileId": MADE_ID, "seed": 7}]}
        self.downloaded = []
        self.patches = [
            mock.patch.object(bridge, "tg", side_effect=self.fake_tg),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 5}),
            mock.patch.object(bridge, "cli", side_effect=self.fake_cli),
            mock.patch.object(bridge, "cli_env", side_effect=self.fake_cli_env),
            mock.patch.object(bridge, "cli_stdin", side_effect=self.fake_cli_stdin),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-10-10T12:00:00Z"),
            mock.patch.object(bridge.urllib.request, "urlopen", side_effect=self.fake_urlopen),
        ]
        (self.tg, self.upload, self.cli, self.cli_env, self.cli_stdin, _, _, _,
         self.urlopen) = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    # ── fakes ──────────────────────────────────────────────────────────────
    def fake_tg(self, token, method, http_timeout=20, **params):
        if method == "getFile":
            return {"file_id": params.get("file_id"), "file_path": f"photos/{params.get('file_id')}.jpg",
                    "file_size": len(JPEG)}
        return {"message_id": 9}

    def fake_urlopen(self, url, timeout=None):
        self.downloaded.append(url)
        return FakeDownload(JPEG)

    def fake_cli(self, *parts):
        if parts[:2] == ("chat", "image"):
            return {"ok": True, "fileId": parts[2], "contentType": "image/jpeg", "byteSize": len(JPEG),
                    "contentBase64": base64.b64encode(JPEG).decode()}
        return None

    def fake_cli_stdin(self, data, *parts, timeout=90, env=None):
        if parts[:2] == ("chat", "attach"):
            return self.attach_result
        if parts[:2] == ("telegram", "people-ask"):
            return self.people_result
        return None

    def fake_cli_env(self, env, *parts, timeout=90):
        if parts[:2] == ("chat", "send"):
            return {"ok": True, "lane": "a", "taskRef": None,
                    "result": {"conversationId": CONV, "response": self.answer,
                               "actions": [{"tool": "paperclip_media-studio__generate-image", "ok": True,
                                            "summary": "Made a picture",
                                            "image": {"fileId": MADE_ID, "seed": 42, "issueId": None}}]}}
        if parts[:2] == ("telegram", "people-ask"):
            return {"ok": True, "outcome": "answered", "reply": "Plain answer.", "requestId": "r2"}
        return None

    # ── helpers ────────────────────────────────────────────────────────────
    def texts(self):
        return [c.kwargs["text"] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def calls(self, mocked, *prefix):
        return [c for c in mocked.call_args_list if c.args[1:1 + len(prefix)] == prefix]

    def handle(self, bot, m):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            bridge.handle_message(self.state, bot, m)
        return out.getvalue()


class AllowedPersonPhotoTests(Base):
    def test_a_photo_with_a_caption_is_stored_and_sent_to_the_agent_with_the_photo_attached(self):
        log = self.handle(make_bot(), photo_message(caption=CAPTION))

        # The largest size was downloaded, through the bot's own token.
        get_files = [c for c in self.tg.call_args_list if c.args[1] == "getFile"]
        self.assertEqual([c.kwargs["file_id"] for c in get_files], ["large"])
        self.assertEqual(len(self.downloaded), 1)
        # Stored in the bot's company's Files, the bytes as base64 on standard input.
        attaches = self.calls(self.cli_stdin, "chat", "attach")
        self.assertEqual(len(attaches), 1)
        self.assertEqual(base64.b64decode(attaches[0].args[0]), JPEG)
        parts = attaches[0].args[1:]
        self.assertEqual(parts[parts.index("-C") + 1], COMPANY)
        self.assertIn("--stdin", parts)
        self.assertNotIn(base64.b64encode(JPEG).decode(), " ".join(parts))
        # The caption went to the agent as the message, with the photo attached.
        sends = self.calls(self.cli_env, "chat", "send")
        self.assertEqual(len(sends), 1)
        self.assertEqual(sends[0].args[0], {"TT": CAPTION})
        send_parts = sends[0].args[1:]
        self.assertEqual(send_parts[send_parts.index("--attachment") + 1], FILE_ID)
        self.assertNotIn("--lane", send_parts)
        # The answer and the edited picture came back into the chat.
        self.assertIn(self.answer, self.texts())
        self.assertEqual(self.upload.call_args.args[1], "sendPhoto")
        self.assertIn("received photo for Maja in chat 111111", log)

    def test_a_picture_sent_as_a_file_is_handled_like_a_photo(self):
        m = {"chat": {"id": OPERATOR, "type": "private"}, "from": {"id": OPERATOR}, "caption": "make it look like winter",
             "document": {"file_id": "doc-1", "file_size": 5000, "mime_type": "image/png", "file_name": "kitchen.png"}}
        log = self.handle(make_bot(), m)
        self.assertEqual(len(self.calls(self.cli_stdin, "chat", "attach")), 1)
        send_parts = self.calls(self.cli_env, "chat", "send")[0].args[1:]
        self.assertIn(FILE_ID, send_parts)
        self.assertIn("received image_file for Maja", log)

    def test_task_in_a_caption_still_makes_a_task(self):
        self.handle(make_bot(), photo_message(caption="/task frame this for the shop window"))
        sends = self.calls(self.cli_env, "chat", "send")
        self.assertEqual(sends[0].args[0], {"TT": "frame this for the shop window"})
        self.assertEqual(sends[0].args[1:][sends[0].args[1:].index("--lane") + 1], "b")
        self.assertIn(FILE_ID, sends[0].args[1:])

    def test_a_photo_without_a_caption_asks_what_to_do_and_goes_with_the_next_message(self):
        bot = make_bot()
        self.handle(bot, photo_message())
        self.assertEqual(self.calls(self.cli_stdin, "chat", "attach"), [])
        self.assertEqual(self.calls(self.cli_env, "chat", "send"), [])
        self.assertEqual(len(self.texts()), 1)
        self.assertTrue(self.texts()[0].startswith("Got the photo. What should Maja do with it?"))
        self.assertEqual(self.downloaded, [])  # nothing downloaded until it is needed

        self.handle(bot, text_message("put a chef's hat on him"))
        self.assertEqual(len(self.calls(self.cli_stdin, "chat", "attach")), 1)
        sends = self.calls(self.cli_env, "chat", "send")
        self.assertEqual(sends[0].args[0], {"TT": "put a chef's hat on him"})
        self.assertIn(FILE_ID, sends[0].args[1:])

        # Used once: the message after that is a normal one.
        self.handle(bot, text_message("thanks!"))
        self.assertNotIn("--attachment", self.calls(self.cli_env, "chat", "send")[-1].args[1:])

    def test_new_forgets_a_waiting_photo(self):
        bot = make_bot()
        self.handle(bot, photo_message())
        self.handle(bot, text_message("/new"))
        self.handle(bot, text_message("hello"))
        self.assertEqual(self.calls(self.cli_stdin, "chat", "attach"), [])

    def test_a_photo_over_10_mb_is_refused_without_downloading_it(self):
        big = [{"file_id": "huge", "file_size": 11 * 1024 * 1024, "width": 6000, "height": 4000}]
        log = self.handle(make_bot(), photo_message(caption=CAPTION, sizes=big))
        self.assertEqual(self.texts(), [bridge.PHOTO_TOO_LARGE])
        self.assertEqual(self.downloaded, [])
        self.assertEqual(self.calls(self.cli_env, "chat", "send"), [])
        self.assertIn("dropped photo for Maja in chat 111111: larger than 10 MB", log)

    def test_a_photo_paperclip_could_not_store_is_explained_and_not_sent_on(self):
        self.attach_result = {"ok": False, "status": 415, "error": "That file is not a JPEG, PNG or WebP picture."}
        log = self.handle(make_bot(), photo_message(caption=CAPTION))
        self.assertEqual(self.calls(self.cli_env, "chat", "send"), [])
        self.assertEqual(self.texts(), [
            "I couldn't save that photo in Paperclip, so it was not passed on. "
            "That file is not a JPEG, PNG or WebP picture. Please send it again."])
        self.assertIn("dropped photo", log)


class UnsupportedMessageTests(Base):
    def check(self, extra, kind, reply):
        m = {"chat": {"id": OPERATOR, "type": "private"}, "from": {"id": OPERATOR}}
        m.update(extra)
        log = self.handle(make_bot(), m)
        self.assertEqual(self.texts(), [reply])
        self.assertEqual(self.calls(self.cli_env, "chat", "send"), [])
        self.assertIn(f"received {kind} for Maja in chat {OPERATOR}", log)
        self.assertIn(f"dropped {kind} for Maja in chat {OPERATOR}: cannot open this kind of message", log)

    def test_a_sticker_gets_a_plain_reply(self):
        self.check({"sticker": {"file_id": "s", "emoji": "😀"}}, "sticker",
                   "I can't read stickers. Write it as text, or send a photo.")

    def test_a_video_gets_a_plain_reply(self):
        self.check({"video": {"file_id": "v"}, "caption": "look"}, "video",
                   "I can't open videos yet. Send a photo or write it as text.")
        self.tg.reset_mock()
        self.check({"animation": {"file_id": "g"}, "document": {"file_id": "g", "mime_type": "video/mp4"}}, "video",
                   "I can't open videos yet. Send a photo or write it as text.")

    def test_another_kind_of_file_gets_a_plain_reply(self):
        self.check({"document": {"file_id": "d", "mime_type": "application/pdf"}}, "file",
                   bridge.UNSUPPORTED_REPLIES["file"])

    def test_a_location_gets_a_plain_reply(self):
        self.check({"location": {"latitude": 59.9, "longitude": 10.7}}, "other",
                   "I can't read that kind of message. Write it as text, or send a photo.")

    def test_a_telegram_notice_is_logged_but_not_answered(self):
        log = self.handle(make_bot(), {"chat": {"id": OPERATOR, "type": "private"}, "from": {"id": OPERATOR},
                                       "pinned_message": {"message_id": 3}})
        self.assertEqual(self.texts(), [])
        self.assertIn("dropped service for Maja", log)


class LoggingTests(Base):
    def test_a_received_message_is_logged_with_time_bot_chat_and_kind_never_its_text(self):
        log = self.handle(make_bot(), text_message("our secret sales figure is 42"))
        line = next(l for l in log.splitlines() if " received " in l)
        self.assertRegex(line, r"^telegram-bridge: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ received text for Maja in chat 111111$")
        self.assertNotIn("secret sales figure", log)

    def test_a_caption_is_never_logged(self):
        log = self.handle(make_bot(), photo_message(caption=CAPTION))
        self.assertNotIn("kitchen", log)
        self.assertNotIn("large", log)  # nor the Telegram file id

    def test_a_stranger_is_still_ignored_and_the_reason_is_logged(self):
        m = photo_message(sender=STRANGER, caption=CAPTION)
        log = self.handle(make_bot(), m)
        self.assertEqual(self.texts(), [])
        self.assertEqual(self.downloaded, [])
        self.assertEqual(self.calls(self.cli_stdin, "chat", "attach"), [])
        self.assertIn(f"received photo for Maja in chat {STRANGER}", log)
        self.assertIn(f"dropped photo for Maja in chat {STRANGER}: sender is not allowed", log)

    def test_a_group_chat_is_still_ignored(self):
        m = photo_message(caption=CAPTION)
        m["chat"] = {"id": -100, "type": "group"}
        log = self.handle(make_bot(), m)
        self.assertEqual(self.texts(), [])
        self.assertIn("dropped photo for Maja in chat -100: not a private chat", log)

    def test_the_bot_token_never_reaches_a_log_line(self):
        self.urlopen.side_effect = OSError(f"https://api.telegram.org/bot{TOKEN}/getFile failed")
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            ORIGINAL_TG(TOKEN, "getFile", file_id="x")
        self.assertNotIn(TOKEN, out.getvalue())
        self.assertIn("<bot token>", out.getvalue())

    def test_a_failed_photo_download_does_not_log_the_address(self):
        self.urlopen.side_effect = OSError(f"https://api.telegram.org/file/bot{TOKEN}/photos/large.jpg failed")
        log = self.handle(make_bot(), photo_message(caption=CAPTION))
        self.assertNotIn(TOKEN, log)
        self.assertIn("could not download a photo (OSError)", log)
        self.assertEqual(self.texts(), ["I couldn't get that photo from Telegram. Please send it again."])


class LinkedPersonPhotoTests(Base):
    def people_bot(self):
        return make_bot(answersLinkedPeople=True)

    def test_a_linked_persons_photo_goes_with_the_question_and_the_answer_picture_comes_back(self):
        self.handle(self.people_bot(), photo_message(sender=PERSON, caption=CAPTION))
        # Not stored by the bridge: the photo travels with the question.
        self.assertEqual(self.calls(self.cli_stdin, "chat", "attach"), [])
        asks = self.calls(self.cli_stdin, "telegram", "people-ask")
        self.assertEqual(len(asks), 1)
        self.assertEqual(base64.b64decode(asks[0].args[0]), JPEG)
        self.assertEqual(asks[0].kwargs["env"], {"TT": CAPTION})
        parts = asks[0].args[1:]
        self.assertIn("--picture-stdin", parts)
        self.assertEqual(parts[parts.index("-C") + 1], COMPANY)
        self.assertEqual(parts[parts.index("--telegram-user-id") + 1], str(PERSON))
        self.assertIn("Done, here it is.", self.texts())
        # The picture the quick agent made was fetched and sent as a photo.
        self.assertTrue(any(c.args[:2] == ("chat", "image") and c.args[2] == MADE_ID for c in self.cli.call_args_list))
        self.assertEqual(self.upload.call_args.args[1], "sendPhoto")

    def test_a_linked_persons_photo_without_caption_waits_for_the_question(self):
        bot = self.people_bot()
        self.handle(bot, photo_message(sender=PERSON))
        self.assertTrue(self.texts()[0].startswith("Got the photo. What should I do with it?"))
        self.assertEqual(self.calls(self.cli_stdin, "telegram", "people-ask"), [])
        self.handle(bot, text_message("make it black and white", sender=PERSON))
        asks = self.calls(self.cli_stdin, "telegram", "people-ask")
        self.assertEqual(len(asks), 1)
        self.assertEqual(asks[0].kwargs["env"], {"TT": "make it black and white"})

    def test_a_linked_persons_sticker_gets_a_plain_reply(self):
        m = {"chat": {"id": PERSON, "type": "private"}, "from": {"id": PERSON}, "sticker": {"file_id": "s"}}
        self.handle(self.people_bot(), m)
        self.assertEqual(self.texts(), ["I can't read stickers. Write it as text, or send a photo."])
        self.assertEqual(self.calls(self.cli_env, "telegram", "people-ask"), [])

    def test_an_unlinked_person_told_a_moment_ago_gets_nothing_not_even_a_download(self):
        bridge.PEOPLE_UNLINKED_UNTIL[(TOKEN, PERSON)] = 9e18
        log = self.handle(self.people_bot(), photo_message(sender=PERSON, caption=CAPTION))
        self.assertEqual(self.texts(), [])
        self.assertEqual(self.downloaded, [])
        self.assertIn("has not linked", log)

    def test_a_plain_question_still_goes_without_a_picture(self):
        self.handle(self.people_bot(), text_message("how did sales go?", sender=PERSON))
        asks = self.calls(self.cli_env, "telegram", "people-ask")
        self.assertEqual(len(asks), 1)
        self.assertNotIn("--picture-stdin", asks[0].args[1:])
        self.assertEqual(self.texts(), ["Plain answer."])


if __name__ == "__main__":
    unittest.main()
