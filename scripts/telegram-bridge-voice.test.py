#!/usr/bin/env python3
"""Voice messages (run: python3 scripts/telegram-bridge-voice.test.py).

Hold the mic in Telegram, speak to a quick agent: the bridge downloads the
voice message, Paperclip turns it into text (`speech transcribe`, the
recording on standard input), the bridge says "You said: …", and the words go
to the agent exactly like a typed message. The answer comes back as text and,
depending on the bot's "Reply with voice" setting, also read aloud
(`speech speak`, sent with sendVoice). Nothing real is called: Telegram, the
download and Paperclip are all fakes.
"""
import base64
import importlib.util
import io
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_voice", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT_ID = "b0000000-0000-4000-8000-000000000001"
CONV = "d0000000-0000-4000-8000-000000000001"
RECORDING = b"OggS\x00\x02fake-opus-recording"
SPOKEN = b"OggS\x00\x02OpusHead-fake-spoken-answer"


def make_bot(mode="when_voice", voice="cedar"):
    return {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
            "companyId": COMPANY, "uiBase": "https://paperclip.example", "botId": BOT_ID,
            "voiceReplyMode": mode, "voice": voice}


def quick(response):
    return {"ok": True, "lane": "a", "result": {"conversationId": CONV, "response": response, "actions": []},
            "taskRef": None}


class FakeDownload(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class VoiceTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {"bot-token": {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR}
        self.transcript = "hvor mange sofaer solgte vi i går?"
        self.answer = "Vi solgte 12 sofaer i går."
        self.speak_result = {"ok": True, "audioBase64": base64.b64encode(SPOKEN).decode(), "contentType": "audio/ogg",
                             "oggOpus": True, "characters": 26, "truncated": False}
        self.patches = [
            mock.patch.object(bridge, "tg", side_effect=self.fake_tg),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", side_effect=self.fake_cli_env),
            mock.patch.object(bridge, "cli_stdin", side_effect=self.fake_cli_stdin),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-09-28T12:00:00Z"),
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
            return {"file_id": params.get("file_id"), "file_path": "voice/file_7.oga", "file_size": len(RECORDING)}
        return {}

    def fake_urlopen(self, url, timeout=None):
        self.assertIn("/file/botbot-token/voice/file_7.oga", url)
        return FakeDownload(RECORDING)

    def fake_cli_stdin(self, data, *parts, timeout=90):
        return {"ok": True, "text": self.transcript, "billedSeconds": 3, "model": "gpt-4o-mini-transcribe"}

    def fake_cli_env(self, env, *parts, timeout=90):
        if parts[:2] == ("chat", "send"):
            return quick(self.answer)
        if parts[:2] == ("speech", "speak"):
            return self.speak_result
        return None

    # ── helpers ────────────────────────────────────────────────────────────
    def texts(self):
        return [c.kwargs["text"] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def chat_sends(self):
        return [c for c in self.cli_env.call_args_list if c.args[1:3] == ("chat", "send")]

    def speaks(self):
        return [c for c in self.cli_env.call_args_list if c.args[1:3] == ("speech", "speak")]

    def send_voice(self, bot, duration=3, file_size=None, kind="voice"):
        media = {"file_id": "AwACAgQAAxkBAAIB", "duration": duration}
        if file_size is not None:
            media["file_size"] = file_size
        bridge.handle_message(self.state, bot, {"chat": {"id": OPERATOR, "type": "private"},
                                                "from": {"id": OPERATOR}, kind: media})

    def send_text(self, bot, text):
        bridge.handle_message(self.state, bot, {"chat": {"id": OPERATOR, "type": "private"},
                                                "from": {"id": OPERATOR}, "text": text})

    # ── voice in ───────────────────────────────────────────────────────────
    def test_voice_in_is_transcribed_echoed_and_sent_to_the_agent_like_typed_text(self):
        self.send_voice(make_bot())

        self.assertEqual(self.cli_stdin.call_count, 1)
        data = self.cli_stdin.call_args.args[0]
        parts = self.cli_stdin.call_args.args[1:]
        # The recording travels as base64 on standard input, never in the command.
        self.assertEqual(base64.b64decode(data), RECORDING)
        self.assertEqual(parts[:2], ("speech", "transcribe"))
        self.assertIn("--stdin", parts)
        self.assertEqual(parts[parts.index("-C") + 1], COMPANY)
        self.assertEqual(parts[parts.index("--source") + 1], "telegram")
        self.assertEqual(parts[parts.index("--filename") + 1], "file_7.oga")
        self.assertEqual(parts[parts.index("--duration") + 1], "3")
        self.assertEqual(parts[parts.index("--telegram-bot-id") + 1], BOT_ID)
        self.assertNotIn(base64.b64encode(RECORDING).decode(), " ".join(parts))

        texts = self.texts()
        self.assertEqual(texts[0], f"🎙️ You said: {self.transcript}")
        # The same chat router call a typed message makes, with the transcript.
        self.assertEqual(len(self.chat_sends()), 1)
        send = self.chat_sends()[0]
        self.assertEqual(send.args[0], {"TT": self.transcript})
        self.assertNotIn("--lane", send.args)
        self.assertIn(self.answer, texts)

    def test_an_audio_file_is_handled_like_a_voice_message(self):
        self.send_voice(make_bot(), kind="audio")
        self.assertEqual(self.cli_stdin.call_count, 1)
        self.assertEqual(self.chat_sends()[0].args[0], {"TT": self.transcript})

    def test_the_echo_is_short(self):
        self.transcript = "ord " * 400
        self.send_voice(make_bot())
        echo = self.texts()[0]
        self.assertTrue(echo.startswith("🎙️ You said: "))
        self.assertLessEqual(bridge.tg_len(echo), len("🎙️ You said: ") + bridge.VOICE_ECHO_MAX + 2)
        # The agent still gets all of it.
        self.assertEqual(self.chat_sends()[0].args[0], {"TT": self.transcript.strip()})

    def test_commands_in_a_transcript_are_not_executed(self):
        bot = make_bot()
        bridge.set_conversation(self.state, bot["token"], OPERATOR, CONV)
        for said in ("/new", "/task buy milk", "/status", "/project Secret", "/start"):
            self.cli_env.reset_mock()
            self.cli.reset_mock()
            self.transcript = said
            self.send_voice(bot)
            sends = self.chat_sends()
            self.assertEqual(len(sends), 1, said)
            self.assertEqual(sends[0].args[0], {"TT": said})
            # Not forced into a task, not a new conversation, no project, no status.
            self.assertNotIn("--lane", sends[0].args)
            self.assertIn("--conversation-id", sends[0].args)
            self.assertEqual(self.cli.call_count, 0, said)
        self.assertEqual(bridge.get_conversation(self.state, bot["token"], OPERATOR), CONV)

    def test_a_voice_message_over_five_minutes_is_refused_in_plain_words(self):
        self.send_voice(make_bot(), duration=301)
        self.assertEqual(self.texts(), ["That voice message is longer than 5 minutes. Please send a shorter one, or type it."])
        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(self.cli_stdin.call_count, 0)
        self.assertEqual(self.chat_sends(), [])

    def test_a_recording_over_20_mb_is_refused_without_downloading_it(self):
        self.send_voice(make_bot(), duration=60, file_size=21 * 1024 * 1024)
        self.assertEqual(self.texts(), ["That recording is larger than 20 MB. Please send a shorter one, or type it."])
        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(self.cli_stdin.call_count, 0)

    def test_a_refused_transcription_is_explained_and_nothing_reaches_the_agent(self):
        self.cli_stdin.side_effect = None
        self.cli_stdin.return_value = {
            "ok": False, "status": 503, "code": "SPEECH_KEY_MISSING",
            "error": "Voice messages are not set up yet: pick an OpenAI key under Connections → Telegram → Voice messages."}
        self.send_voice(make_bot())
        self.assertEqual(self.texts(), [
            "I couldn't listen to that voice message. Voice messages are not set up yet: pick an OpenAI key "
            "under Connections → Telegram → Voice messages."])
        self.assertEqual(self.chat_sends(), [])

    def test_silence_is_not_sent_to_the_agent(self):
        self.transcript = "   "
        self.send_voice(make_bot())
        self.assertEqual(self.texts(), ["I couldn't hear any words in that voice message. Please try again, or type it."])
        self.assertEqual(self.chat_sends(), [])

    def test_a_stranger_voice_message_is_ignored(self):
        bridge.handle_message(self.state, make_bot(), {"chat": {"id": 999, "type": "private"}, "from": {"id": 999},
                                                       "voice": {"file_id": "x", "duration": 2}})
        self.assertEqual(self.urlopen.call_count, 0)
        self.assertEqual(self.cli_stdin.call_count, 0)
        self.assertEqual(self.texts(), [])

    # ── voice out ──────────────────────────────────────────────────────────
    def test_when_voice_mode_reads_the_answer_aloud_after_a_voice_message(self):
        self.send_voice(make_bot("when_voice", "cedar"))
        speaks = self.speaks()
        self.assertEqual(len(speaks), 1)
        self.assertEqual(speaks[0].args[0], {"TT": self.answer})
        parts = speaks[0].args[1:]
        self.assertEqual(parts[parts.index("--voice") + 1], "cedar")
        self.assertEqual(parts[parts.index("--source") + 1], "telegram")
        self.assertEqual(parts[parts.index("-C") + 1], COMPANY)
        # The text answer goes first, then the voice message.
        self.assertIn(self.answer, self.texts())
        self.upload.assert_called_once_with("bot-token", "sendVoice", "voice", "answer.ogg", "audio/ogg", SPOKEN,
                                            chat_id=OPERATOR)

    def test_when_voice_mode_does_not_read_aloud_after_a_typed_message(self):
        self.send_text(make_bot("when_voice"), "hvor mange sofaer?")
        self.assertEqual(self.speaks(), [])
        self.upload.assert_not_called()

    def test_always_mode_reads_aloud_after_a_typed_message(self):
        self.send_text(make_bot("always"), "hvor mange sofaer?")
        self.assertEqual(len(self.speaks()), 1)
        self.assertEqual(self.upload.call_args.args[1], "sendVoice")

    def test_never_mode_does_not_read_aloud_even_after_a_voice_message(self):
        self.send_voice(make_bot("never"))
        self.assertEqual(self.speaks(), [])
        self.upload.assert_not_called()
        self.assertIn(self.answer, self.texts())

    def test_a_task_confirmation_is_not_read_aloud(self):
        def cli_env(env, *parts, timeout=90):
            if parts[:2] == ("chat", "send"):
                return {"ok": True, "lane": "b",
                        "taskRef": {"issueId": "e0000000-0000-4000-8000-000000000001", "identifier": "NOR-1"}}
            return self.speak_result
        self.cli_env.side_effect = cli_env
        self.send_voice(make_bot("always"))
        self.assertEqual(self.speaks(), [])

    def test_audio_that_is_not_ogg_opus_goes_as_an_audio_file(self):
        self.speak_result = {"ok": True, "audioBase64": base64.b64encode(b"ID3mp3").decode(),
                             "contentType": "audio/mpeg", "oggOpus": False}
        self.send_voice(make_bot())
        self.upload.assert_called_once_with("bot-token", "sendAudio", "audio", "answer.mp3", "audio/mpeg", b"ID3mp3",
                                            chat_id=OPERATOR, title="Answer")

    def test_a_refused_voice_message_falls_back_to_an_audio_file(self):
        self.upload.side_effect = [None, {"message_id": 2}]
        self.send_voice(make_bot())
        self.assertEqual([c.args[1] for c in self.upload.call_args_list], ["sendVoice", "sendAudio"])

    def test_a_refused_reading_is_one_plain_line(self):
        self.speak_result = {"ok": False, "status": 429, "code": "SPEECH_DAILY_LIMIT",
                             "error": "Today's allowance for reading answers aloud (50,000 characters) is used up."}
        self.send_voice(make_bot())
        self.assertEqual(self.texts()[-1], "(I couldn't read the answer aloud. Today's allowance for reading "
                                           "answers aloud (50,000 characters) is used up.)")
        self.upload.assert_not_called()

    def test_an_invalid_voice_name_is_never_put_in_the_command(self):
        bot = make_bot("always", voice="x; rm -rf /")
        self.send_text(bot, "hei")
        self.assertNotIn("--voice", self.speaks()[0].args)


class SendVoiceMultipartTests(unittest.TestCase):
    def test_send_voice_uploads_the_ogg_file_as_multipart(self):
        captured = {}

        class Response(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["body"] = request.data
            captured["type"] = request.headers.get("Content-type")
            return Response(b'{"ok": true, "result": {"message_id": 5}}')

        with mock.patch.object(bridge.urllib.request, "urlopen", side_effect=urlopen):
            result = bridge.tg_upload("bot-token", "sendVoice", "voice", "answer.ogg", "audio/ogg", SPOKEN,
                                      chat_id=OPERATOR)

        self.assertEqual(result, {"message_id": 5})
        self.assertEqual(captured["url"], "https://api.telegram.org/botbot-token/sendVoice")
        self.assertTrue(captured["type"].startswith("multipart/form-data; boundary="))
        body = captured["body"]
        self.assertIn(b'Content-Disposition: form-data; name="chat_id"\r\n\r\n111111\r\n', body)
        self.assertIn(b'Content-Disposition: form-data; name="voice"; filename="answer.ogg"\r\n'
                      b'Content-Type: audio/ogg\r\n\r\n' + SPOKEN, body)


class RosterAndContractTests(unittest.TestCase):
    def test_the_roster_carries_the_voice_settings(self):
        roster = {"bots": [
            {"id": BOT_ID, "agentId": "a1", "token": "t1", "companyId": COMPANY, "voiceReplyMode": "always",
             "voice": "marin"},
            {"id": "not-a-uuid", "agentId": "a2", "token": "t2", "companyId": COMPANY, "voiceReplyMode": "loud",
             "voice": "Marin; echo"},
            {"agentId": "a3", "token": "t3", "companyId": COMPANY},
        ]}
        with mock.patch.object(bridge, "cli", return_value=roster):
            bots = bridge.fetch_bots_from_api()
        self.assertEqual([(b["botId"], b["voiceReplyMode"], b["voice"]) for b in bots], [
            (BOT_ID, "always", "marin"),
            (None, "when_voice", None),
            (None, "when_voice", None),
        ])

    def test_the_cli_commands_the_bridge_calls_exist(self):
        source_path = os.path.join(HERE, "..", "cli", "src", "commands", "client", "speech.ts")
        with open(source_path) as f:
            source = f.read()
        for needle in ('.command("transcribe")', '.command("speak")', '"--stdin"', "--telegram-bot-id <id>",
                       "--duration <seconds>", "--filename <name>", "--voice <voice>", "--text <text>"):
            self.assertIn(needle, source)


if __name__ == "__main__":
    unittest.main()
