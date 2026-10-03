#!/usr/bin/env python3
"""Pictures in quick answers (run: python3 scripts/telegram-bridge-images.test.py).

A quick agent can make a picture (Media Studio's "Generate image") while it
answers. The bridge then fetches the picture's bytes from Paperclip with its
own sign-in and the bot's own company, and uploads them to Telegram as a photo
with a short caption. Telegram never gets a Paperclip address. A reply with no
picture is sent exactly as before, as plain text.
"""
import base64
import importlib.util
import os
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
BRIDGE_PATH = os.environ.get("TELEGRAM_BRIDGE_UNDER_TEST") or os.path.join(HERE, "telegram-bridge.py")
spec = importlib.util.spec_from_file_location("telegram_bridge_images", BRIDGE_PATH)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

OPERATOR = 111111
COMPANY = "c0000000-0000-4000-8000-000000000001"
BOT = {"token": "bot-token", "agentId": "a0000000-0000-4000-8000-000000000001", "name": "Maja",
       "companyId": COMPANY, "uiBase": "https://paperclip.example"}
CONV = "d0000000-0000-4000-8000-000000000001"
FILE1 = "f0000000-0000-4000-8000-000000000001"
FILE2 = "f0000000-0000-4000-8000-000000000002"
JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes"


def quick(response, actions):
    return {"ok": True, "lane": "a",
            "result": {"conversationId": CONV, "response": response, "actions": actions},
            "taskRef": None}


def image_action(file_id, seed=4242, issue_id=None):
    return {"tool": "paperclip_media-studio__generate-image", "ok": True,
            "summary": "Made a picture with the Generate image (Media Studio) add-on tool and saved it to Files.",
            "image": {"fileId": file_id, "contentPath": f"/api/attachments/{file_id}/content",
                      "contentType": "image/jpeg", "seed": seed, "issueId": issue_id}}


def picture(file_id, content_type="image/jpeg", data=JPEG):
    return {"ok": True, "fileId": file_id, "contentType": content_type, "byteSize": len(data),
            "contentBase64": base64.b64encode(data).decode()}


class ImageReplyTests(unittest.TestCase):
    def setUp(self):
        self.state = {"bots": {BOT["token"]: {"offset": 0, "chats": [OPERATOR]}}, "notified": []}
        bridge.ALLOWED_USER_IDS = {OPERATOR}
        self.patches = [
            mock.patch.object(bridge, "tg", return_value={}),
            mock.patch.object(bridge, "tg_upload", return_value={"message_id": 1}),
            mock.patch.object(bridge, "cli", return_value=None),
            mock.patch.object(bridge, "cli_env", return_value=None),
            mock.patch.object(bridge, "save_state"),
            mock.patch.object(bridge, "paperclip_ready", return_value=True),
            mock.patch.object(bridge, "container_started_at", return_value="2026-09-27T12:00:00Z"),
        ]
        self.tg, self.upload, self.cli, self.cli_env, _, _, _ = [p.start() for p in self.patches]

    def tearDown(self):
        for p in self.patches:
            p.stop()

    def texts(self):
        return [c.kwargs["text"] for c in self.tg.call_args_list if c.args[1] == "sendMessage"]

    def ask(self, text="make a picture of a sofa"):
        bridge.handle_message(self.state, BOT, {"chat": {"id": OPERATOR, "type": "private"},
                                                "from": {"id": OPERATOR}, "text": text})

    def test_a_picture_in_the_reply_is_uploaded_as_a_photo_with_a_caption(self):
        self.cli_env.return_value = quick("Here is the sofa.", [image_action(FILE1)])
        self.cli.return_value = picture(FILE1)

        self.ask()

        self.assertEqual(self.texts(), ["Here is the sofa."])
        # The bytes come from Paperclip through the CLI, in the bot's own company.
        self.cli.assert_called_once_with("chat", "image", FILE1, "-C", COMPANY)
        self.upload.assert_called_once()
        call = self.upload.call_args
        token, method, field, filename, content_type, data = call.args
        self.assertEqual((token, method, field, content_type, data), (BOT["token"], "sendPhoto", "photo", "image/jpeg", JPEG))
        self.assertTrue(filename.endswith(".jpeg"))
        self.assertEqual(call.kwargs["chat_id"], OPERATOR)
        self.assertEqual(call.kwargs["caption"], "Saved in Paperclip's Files. Seed 4242.")
        # Telegram never gets a Paperclip address.
        self.assertNotIn("/api/attachments", repr(call))
        self.assertNotIn("paperclip.example", repr(call))

    def test_a_plain_reply_is_still_plain_text(self):
        self.cli_env.return_value = quick("It is sunny.", [{"tool": "get_weather", "summary": "Weather.", "ok": True}])

        self.ask("weather?")

        self.assertEqual(self.texts(), ["It is sunny."])
        self.upload.assert_not_called()
        self.cli.assert_not_called()

    def test_a_reply_without_actions_is_still_plain_text(self):
        self.cli_env.return_value = {"ok": True, "lane": "a",
                                     "result": {"conversationId": CONV, "response": "Hello."}, "taskRef": None}
        self.ask("hi")
        self.assertEqual(self.texts(), ["Hello."])
        self.upload.assert_not_called()

    def test_a_picture_that_cannot_be_fetched_gets_a_plain_line(self):
        self.cli_env.return_value = quick("Done.", [image_action(FILE1)])
        self.cli.return_value = {"ok": False, "status": 404, "error": "That picture was not found."}

        self.ask()

        self.upload.assert_not_called()
        self.assertEqual(self.texts()[-1], "I made a picture but could not send it here. It is in Paperclip's Files.")

    def test_an_svg_goes_as_a_file_not_a_photo(self):
        self.cli_env.return_value = quick("Mock picture.", [image_action(FILE1, seed=None)])
        self.cli.return_value = picture(FILE1, "image/svg+xml", b"<svg/>")

        self.ask()

        self.assertEqual(self.upload.call_args.args[1], "sendDocument")
        self.assertEqual(self.upload.call_args.kwargs["caption"], "Saved in Paperclip's Files.")

    def test_a_refused_photo_falls_back_to_a_file(self):
        self.cli_env.return_value = quick("Here.", [image_action(FILE1)])
        self.cli.return_value = picture(FILE1)
        self.upload.side_effect = [None, {"message_id": 2}]

        self.ask()

        self.assertEqual([c.args[1] for c in self.upload.call_args_list], ["sendPhoto", "sendDocument"])

    def test_a_malformed_file_id_is_ignored(self):
        action = image_action(FILE1)
        action["image"]["fileId"] = "../../etc/passwd"
        self.cli_env.return_value = quick("Here.", [action])

        self.ask()

        self.cli.assert_not_called()
        self.upload.assert_not_called()

    def test_several_pictures_each_go_once(self):
        self.cli_env.return_value = quick("Two.", [image_action(FILE1), image_action(FILE2), image_action(FILE1)])
        self.cli.side_effect = [picture(FILE1), picture(FILE2)]

        self.ask()

        self.assertEqual(self.upload.call_count, 2)

    def test_a_task_picture_says_it_is_on_its_task(self):
        self.cli_env.return_value = quick("Attached.", [image_action(FILE1, seed=7, issue_id="e0000000-0000-4000-8000-000000000001")])
        self.cli.return_value = picture(FILE1)
        self.ask()
        self.assertEqual(self.upload.call_args.kwargs["caption"], "Attached to its task in Paperclip. Seed 7.")


class MultipartTests(unittest.TestCase):
    def test_the_upload_is_multipart_with_the_bytes_and_fields(self):
        captured = {}

        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

            def read(self):
                return b'{"ok": true, "result": {"message_id": 5}}'

        def fake_urlopen(request, timeout=None):
            captured["request"] = request
            return FakeResponse()

        with mock.patch.object(bridge.urllib.request, "urlopen", side_effect=fake_urlopen):
            res = bridge.tg_upload("tok", "sendPhoto", "photo", "picture-1.jpeg", "image/jpeg", JPEG,
                                   chat_id=OPERATOR, caption="Saved in Paperclip's Files.")

        self.assertEqual(res, {"message_id": 5})
        request = captured["request"]
        self.assertEqual(request.full_url, "https://api.telegram.org/bottok/sendPhoto")
        self.assertTrue(request.get_header("Content-type").startswith("multipart/form-data; boundary="))
        body = request.data
        self.assertIn(JPEG, body)
        self.assertIn(b'name="photo"; filename="picture-1.jpeg"', body)
        self.assertIn(b'name="chat_id"\r\n\r\n111111', body)
        self.assertIn(b"Saved in Paperclip's Files.", body)


if __name__ == "__main__":
    unittest.main()
