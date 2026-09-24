"""Regression tests without loading model weights or touching the GPU."""
import contextlib
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import chatterbox_server as server


class FakeWave:
    def squeeze(self): return self
    def cpu(self): return self
    def numpy(self): return np.zeros(2400)


class FakeModel:
    sr = 24000
    def __init__(self):
        self.conds = SimpleNamespace(speaker="default")
        self.preparations = 0
        self.spoken = []
    def prepare_conditionals(self, path, exaggeration):
        self.preparations += 1
        self.conds = SimpleNamespace(speaker=path)
    def generate(self, text, **options):
        assert "audio_prompt_path" not in options
        self.spoken.append(self.conds.speaker)
        return FakeWave()


class VoiceCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "speaker.wav"
        self.path.write_bytes(b"fake reference")
        server._model = FakeModel()
        server._default_conditionals = SimpleNamespace(speaker="default")
        server._voice_conditionals.clear()
        self.torch = patch.dict("sys.modules", {"torch": SimpleNamespace(inference_mode=contextlib.nullcontext)})
        self.torch.start()
    def tearDown(self):
        self.torch.stop()
        self.temp.cleanup()
    def speak(self, voice):
        return server.synthesize_pcm16("Hallo.", "de", 0.5, voice)
    def test_caches_voice_and_restores_default(self):
        self.speak(str(self.path))
        self.speak(str(self.path))
        self.speak(None)
        self.assertEqual(server._model.preparations, 1)
        self.assertEqual(server._model.spoken, [str(self.path), str(self.path), "default"])
    def test_invalidates_modified_reference(self):
        self.speak(str(self.path))
        self.path.write_bytes(b"changed reference with a different size")
        self.speak(str(self.path))
        self.assertEqual(server._model.preparations, 2)
    def test_cache_is_bounded_and_metrics_are_available(self):
        for index in range(4):
            path = Path(self.temp.name) / f"voice{index}.wav"
            path.write_bytes(b"ref")
            self.speak(str(path))
        self.assertLessEqual(len(server._voice_conditionals), server.VOICE_CACHE_SIZE)
        with server.app.test_client() as client:
            health = client.get("/health").get_json()
            self.assertFalse(health["busy"])
            self.assertEqual(health["metrics"]["lastAudioSeconds"], 0.1)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        server._model = FakeModel()
        server._default_conditionals = object()
        server._voice_conditionals["cached"] = object()
        self.client = server.app.test_client()

    def test_unload_releases_references_and_cuda_cache(self):
        from unittest.mock import Mock
        empty = Mock()
        with patch.dict("sys.modules", {"torch": SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True, empty_cache=empty))}):
            self.assertEqual(self.client.post("/model/unload").status_code, 200)
        self.assertIsNone(server._model)
        self.assertIsNone(server._default_conditionals)
        self.assertFalse(server._voice_conditionals)
        empty.assert_called_once()
        self.assertEqual(self.client.post("/synthesize", json={"text": "Hallo"}).status_code, 409)
        self.assertFalse(self.client.get("/health").get_json()["busy"])

    def test_reload_and_idempotent_load(self):
        server._model = None
        def load(): server._model = FakeModel()
        with patch.object(server, "load_model", side_effect=load) as loader, patch.object(server, "warmup_model"):
            self.assertEqual(self.client.post("/model/load").status_code, 200)
            self.assertEqual(self.client.post("/model/load").status_code, 200)
            loader.assert_called_once()

    def test_busy_unload_does_not_interrupt_synthesis(self):
        import threading
        ready, release = threading.Event(), threading.Event()
        def hold():
            with server._model_lock:
                ready.set()
                release.wait(5)
        thread = threading.Thread(target=hold)
        thread.start()
        ready.wait(5)
        try:
            self.assertEqual(self.client.post("/model/unload").status_code, 409)
            self.assertIsNotNone(server._model)
        finally:
            release.set()
            thread.join()

    def test_failed_load_releases_lock(self):
        server._model = None
        with patch.object(server, "load_model", side_effect=RuntimeError("download failed")):
            self.assertEqual(self.client.post("/model/load").status_code, 500)
        self.assertFalse(self.client.get("/health").get_json()["busy"])


class ModelSelectionTests(unittest.TestCase):
    def run_load(self, factory, requested="v3"):
        import os
        server._model = None
        server._device = "cpu"
        with patch.dict(os.environ, {"CHATTERBOX_MODEL": requested}), patch.dict("sys.modules", {
            "torch": SimpleNamespace(),
            "chatterbox.mtl_tts": SimpleNamespace(ChatterboxMultilingualTTS=SimpleNamespace(from_pretrained=factory)),
        }):
            server.load_model()

    def test_current_api_selects_v3(self):
        calls = []
        def factory(device, t3_model="v2"):
            calls.append(t3_model)
            return FakeModel()
        self.run_load(factory)
        self.assertEqual(calls, ["v3"])
        self.assertEqual(server._model_variant, "v3")

    def test_legacy_api_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, "does not support V3"):
            self.run_load(lambda device: FakeModel())
        self.assertIsNone(server._model)

    def test_legacy_model_override_is_rejected(self):
        for requested in ("v2", "auto"):
            with self.assertRaisesRegex(ValueError, "requires CHATTERBOX_MODEL=v3"):
                self.run_load(lambda device, t3_model: FakeModel(), requested)



if __name__ == "__main__":
    unittest.main()
