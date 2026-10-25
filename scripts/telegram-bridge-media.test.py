#!/usr/bin/env python3
"""Media Studio video/audio jobs through Telegram (run: python3 scripts/telegram-bridge-media.test.py).

A video or music/audio generation runs as a background job (media-jobs.ts)
because it can take minutes; when it finishes it posts a task-answer comment
in the exact shape "Your <kind> is ready: <filename> (file id <uuid>)." This
is picked up the same way as any other task answer (notify_task_answers), but
instead of just forwarding that sentence as plain text, the bridge fetches the
file's bytes with `chat media` and uploads it to Telegram as a video or audio
message, with the sentence as the caption. A file that cannot be fetched, is
too big, or an answer that is not this exact shape, falls back to plain text
exactly as before.

Set TELEGRAM_BRIDGE_UNDER_TEST to another copy of telegram-bridge.py to run
these tests against it.
"""
import base64
import importlib.util
import os
import time
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_media", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
OPERATOR2 = 222222
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
ISSUE1 = "e0000000-0000-4000-8000-000000000001"
FILE1 = "f0000000-0000-4000-8000-000000000001"
MP4 = b"fake-mp4-bytes"
MP3 = b"fake-mp3-bytes"


def answer_item(body, comment_id="comment-1", status="done", identifier="DUR-40", issue_id=ISSUE1):
    return {"id": issue_id, "companyId": COMPANY, "identifier": identifier, "title": "A video",
            "status": status,
            "answer": {"commentId": comment_id, "authorAgentId": BOT["agentId"], "body": body,
                       "createdAt": "2026-09-29T10:00:00.000Z"} if comment_id else None,
            "resultDocument": None}


def media(file_id, content_type="video/mp4", data=MP4):
    return {"ok": True, "fileId": file_id, "contentType": content_type, "byteSize": len(data),
            "contentBase64": base64.b64encode(data).decode()}


class MediaJobAnswerTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0,
                                               "tasks": {ISSUE1: {"chat": OPERATOR, "identifier": "DUR-40",
                                                                   "title": "A video", "at": time.time()}}}}}
        # Per bot now (no instance-wide list): every test bot keeps these people.
        bridge.legacy_allowed = lambda token: {OPERATOR, OPERATOR2}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "save_state"),
        ]
        self.tg, self.upload, self.cli, _ = [p.start() for p in self.patches]
        self.cli.side_effect = self._cli

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def _cli(self, *parts):
        if parts[0] == "chat" and parts[1] == "answers":
            return self.answers
        if parts[0] == "chat" and parts[1] == "media":
            return self.media_result
        raise AssertionError(f"unexpected cli call: {parts}")

    def sends(self, method):
        return [c for c in self.upload.call_args_list if c.args[1] == method]

    def test_a_finished_video_job_is_uploaded_as_a_video_with_the_sentence_as_caption(self):
        text = "Your video is ready: video-fal-a1b2c3d4.mp4 (file id f0000000-0000-4000-8000-000000000001)."
        self.answers = {"issues": [answer_item(text)]}
        self.media_result = media(FILE1, "video/mp4", MP4)

        bridge.notify_task_answers(self.state, [BOT])

        self.cli.assert_any_call("chat", "media", FILE1, "-C", COMPANY)
        self.assertEqual(len(self.sends("sendVideo")), 1)
        call = self.sends("sendVideo")[0]
        token, method, field, filename, content_type, data = call.args
        self.assertEqual((token, method, field, content_type, data), (BOT["token"], "sendVideo", "video", "video/mp4", MP4))
        self.assertEqual(call.kwargs["chat_id"], OPERATOR)
        self.assertIn(text, call.kwargs["caption"])
        self.tg.assert_not_called()  # no separate sendMessage: the video carries the text as its caption

    def test_a_finished_audio_job_is_uploaded_as_audio(self):
        text = "Your audio is ready: audio-fal-deadbeef.mp3 (file id f0000000-0000-4000-8000-000000000001)."
        self.answers = {"issues": [answer_item(text)]}
        self.media_result = media(FILE1, "audio/mpeg", MP3)

        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(len(self.sends("sendAudio")), 1)
        call = self.sends("sendAudio")[0]
        self.assertEqual(call.args[1:5], ("sendAudio", "audio", "audio.mpeg", "audio/mpeg"))

    def test_a_file_too_large_falls_back_to_plain_text(self):
        text = "Your video is ready: big.mp4 (file id f0000000-0000-4000-8000-000000000001)."
        self.answers = {"issues": [answer_item(text)]}
        big = b"x" * (bridge.TG_VIDEO_MAX_BYTES + 1)
        self.media_result = {"ok": True, "fileId": FILE1, "contentType": "video/mp4",
                              "byteSize": len(big), "contentBase64": base64.b64encode(big).decode()}

        bridge.notify_task_answers(self.state, [BOT])

        self.upload.assert_not_called()
        self.tg.assert_called_once_with(BOT["token"], "sendMessage", chat_id=OPERATOR, text=mock.ANY,
                                         disable_web_page_preview=True)

    def test_a_file_that_cannot_be_fetched_falls_back_to_plain_text(self):
        text = "Your video is ready: gone.mp4 (file id f0000000-0000-4000-8000-000000000001)."
        self.answers = {"issues": [answer_item(text)]}
        self.media_result = {"ok": False, "status": 404, "error": "not found"}

        bridge.notify_task_answers(self.state, [BOT])

        self.upload.assert_not_called()
        self.tg.assert_called_once()

    def test_an_ordinary_task_answer_is_still_plain_text_with_no_media_lookup(self):
        self.answers = {"issues": [answer_item("The report is done.")]}
        self.media_result = None

        bridge.notify_task_answers(self.state, [BOT])

        self.upload.assert_not_called()
        self.cli.assert_called_once_with("chat", "answers", "-C", COMPANY, ISSUE1)  # no "chat media" call

    def test_a_second_pass_does_not_repost_or_refetch(self):
        text = "Your video is ready: video.mp4 (file id f0000000-0000-4000-8000-000000000001)."
        self.answers = {"issues": [answer_item(text)]}
        self.media_result = media(FILE1)

        bridge.notify_task_answers(self.state, [BOT])
        bridge.notify_task_answers(self.state, [BOT])

        self.assertEqual(len(self.sends("sendVideo")), 1)


if __name__ == "__main__":
    unittest.main()
