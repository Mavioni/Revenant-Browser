"""Persistent speech worker for Lelu.

Loads Whisper and Kokoro on demand, then serves JSON-line requests over stdin/stdout.
"""

from __future__ import annotations

import base64
import io
import json
import math
import os
import re
import sys
import traceback
from typing import Any

import numpy as np
import soundfile as sf

try:
    import torch
except Exception:  # pragma: no cover - dependency availability is runtime-specific
    torch = None

_WHISPER_PIPE = None
_WHISPER_MODEL_ID = ""
_KOKORO_PIPELINES: dict[str, Any] = {}


def emit(payload: dict[str, Any]) -> None:
    sys.__stdout__.write(json.dumps(payload) + "\n")
    sys.__stdout__.flush()


def resolve_device() -> tuple[int, Any | None]:
    if torch is not None and torch.cuda.is_available():
        return 0, torch.float16
    if torch is not None:
        return -1, torch.float32
    return -1, None


def decode_audio_payload(payload: Any) -> tuple[bytes, str | None, str | None]:
    mime_type = None
    language = None

    if isinstance(payload, dict):
        raw_audio = str(payload.get("audioBase64") or payload.get("data") or "")
        mime_type = payload.get("mimeType")
        language = payload.get("language")
    else:
        raw_audio = str(payload or "")

    if not raw_audio:
        raise ValueError("No audio payload was provided.")

    if raw_audio.startswith("data:"):
        header, _, encoded = raw_audio.partition(",")
        raw_audio = encoded
        if ";" in header:
            mime_type = header[5:].split(";", 1)[0]

    try:
        return base64.b64decode(raw_audio), mime_type, language
    except Exception as error:  # pragma: no cover - malformed input
        raise ValueError(f"Invalid audio payload: {error}") from error


def resample_audio(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    if src_rate == dst_rate or len(audio) == 0:
        return audio.astype(np.float32)

    duration = len(audio) / float(src_rate)
    target_length = max(1, int(round(duration * dst_rate)))
    src_positions = np.linspace(0.0, duration, num=len(audio), endpoint=False)
    dst_positions = np.linspace(0.0, duration, num=target_length, endpoint=False)
    return np.interp(dst_positions, src_positions, audio).astype(np.float32)


def load_whisper(model_id: str):
    global _WHISPER_MODEL_ID, _WHISPER_PIPE

    if _WHISPER_PIPE is not None and _WHISPER_MODEL_ID == model_id:
        return _WHISPER_PIPE

    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor, pipeline

    device, torch_dtype = resolve_device()
    model_kwargs: dict[str, Any] = {
        "low_cpu_mem_usage": True,
    }
    if torch_dtype is not None:
        model_kwargs["torch_dtype"] = torch_dtype

    model = AutoModelForSpeechSeq2Seq.from_pretrained(model_id, **model_kwargs)
    if device >= 0 and torch is not None:
        model.to(f"cuda:{device}")

    processor = AutoProcessor.from_pretrained(model_id)

    pipe_kwargs: dict[str, Any] = {
        "task": "automatic-speech-recognition",
        "model": model,
        "tokenizer": processor.tokenizer,
        "feature_extractor": processor.feature_extractor,
        "device": device,
        "chunk_length_s": 30,
        "batch_size": 8 if device >= 0 else 1,
        "return_timestamps": False,
    }
    if torch_dtype is not None:
        pipe_kwargs["torch_dtype"] = torch_dtype

    _WHISPER_PIPE = pipeline(**pipe_kwargs)
    _WHISPER_MODEL_ID = model_id
    return _WHISPER_PIPE


def detect_lang_code(voice: str) -> str:
    voice = (voice or "af_heart").strip().lower()
    if not voice:
        return "a"
    match = re.match(r"([a-z])[a-z]?_", voice)
    if match:
        return match.group(1)
    return voice[0]


def load_kokoro(lang_code: str):
    if lang_code in _KOKORO_PIPELINES:
        return _KOKORO_PIPELINES[lang_code]

    from kokoro import KPipeline

    pipeline = KPipeline(lang_code=lang_code)
    _KOKORO_PIPELINES[lang_code] = pipeline
    return pipeline


def phoneme_to_visemes(phonemes: str) -> list[str]:
    visemes: list[str] = []
    for symbol in phonemes.lower():
        if symbol in {"a", "ɑ", "æ", "ʌ", "ɐ"}:
            visemes.append("aa")
        elif symbol in {"e", "i", "y", "é", "ê"}:
            visemes.append("ee")
        elif symbol in {"ɪ", "ɛ", "ə", "ɜ", "ɚ", "ï"}:
            visemes.append("ih")
        elif symbol in {"o", "ɔ", "ɒ"}:
            visemes.append("oh")
        elif symbol in {"u", "ʊ", "w", "ɯ"}:
            visemes.append("ou")
    return visemes


def build_frames(phonemes: str, audio: np.ndarray, sample_rate: int, start_ms: float) -> list[dict[str, Any]]:
    if len(audio) == 0:
        return []

    window_size = max(1, int(sample_rate * 0.07))
    visemes = phoneme_to_visemes(phonemes)
    frames: list[dict[str, Any]] = []

    for index, start in enumerate(range(0, len(audio), window_size)):
        chunk = audio[start:start + window_size]
        if len(chunk) == 0:
            continue
        rms = float(np.sqrt(np.mean(np.square(chunk))))
        level = max(0.0, min(1.0, rms * 4.5))

        viseme = "rest"
        if visemes:
            viseme_index = min(len(visemes) - 1, int(index * len(visemes) / max(1, math.ceil(len(audio) / window_size))))
            viseme = visemes[viseme_index]
        elif level > 0.18:
            viseme = "aa"

        frames.append({
            "offsetMs": int(round(start_ms + (start / sample_rate) * 1000.0)),
            "level": round(level, 4),
            "viseme": viseme,
        })

    return frames


def handle_transcribe(payload: dict[str, Any]) -> dict[str, Any]:
    model_id = str(payload.get("model") or "openai/whisper-large-v3-turbo")
    audio_bytes, _mime_type, language = decode_audio_payload(payload.get("payload"))

    audio, sample_rate = sf.read(io.BytesIO(audio_bytes), dtype="float32")
    if getattr(audio, "ndim", 1) > 1:
        audio = np.mean(audio, axis=1)

    audio = np.asarray(audio, dtype=np.float32)
    duration_ms = int(round((len(audio) / float(sample_rate)) * 1000.0)) if sample_rate else 0
    if sample_rate != 16000:
        audio = resample_audio(audio, sample_rate, 16000)
        sample_rate = 16000

    whisper = load_whisper(model_id)
    generate_kwargs: dict[str, Any] = {}
    if language:
        generate_kwargs["language"] = language
    result = whisper({"array": audio, "sampling_rate": sample_rate}, generate_kwargs=generate_kwargs)
    text = str(result.get("text") or "").strip()

    return {
        "status": "transcribed",
        "backend": model_id,
        "text": text,
        "language": language,
        "durationMs": duration_ms,
    }


def handle_synthesize(payload: dict[str, Any]) -> dict[str, Any]:
    text = str(payload.get("text") or "").strip()
    if not text:
        raise ValueError("No text was provided for synthesis.")

    options = payload.get("options") or {}
    voice = str(options.get("voice") or "af_heart")
    speed = float(options.get("speed") or 1)
    lang_code = detect_lang_code(voice)
    sample_rate = 24000

    pipeline = load_kokoro(lang_code)
    generated_audio: list[np.ndarray] = []
    frames: list[dict[str, Any]] = []
    cursor_ms = 0.0

    for graphemes, phonemes, audio in pipeline(text, voice=voice, speed=speed, split_pattern=r"\n+"):
        chunk = np.asarray(audio, dtype=np.float32)
        generated_audio.append(chunk)
        frames.extend(build_frames(str(phonemes), chunk, sample_rate, cursor_ms))
        cursor_ms += (len(chunk) / float(sample_rate)) * 1000.0

    if not generated_audio:
        raise ValueError("Kokoro did not generate audio.")

    merged = np.concatenate(generated_audio).astype(np.float32)
    buffer = io.BytesIO()
    sf.write(buffer, merged, sample_rate, format="WAV")

    return {
        "status": "executed",
        "backend": str(payload.get("backend") or "kokoro"),
        "textLength": len(text),
        "voice": voice,
        "mimeType": "audio/wav",
        "sampleRate": sample_rate,
        "durationMs": int(round((len(merged) / float(sample_rate)) * 1000.0)),
        "audioBase64": base64.b64encode(buffer.getvalue()).decode("ascii"),
        "frames": frames,
    }


def dispatch(action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if action == "transcribe":
        return handle_transcribe(payload)
    if action == "synthesize":
        return handle_synthesize(payload)
    raise ValueError(f"Unknown action: {action}")


if __name__ == "__main__":
    emit({"type": "ready"})
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        envelope = json.loads(line)
        request_id = envelope.get("id")
        action = envelope.get("action")
        payload = envelope.get("payload") or {}

        try:
            result = dispatch(str(action), payload)
            emit({"id": request_id, "payload": result})
        except Exception as error:  # pragma: no cover - runtime error reporting
            emit({
                "id": request_id,
                "error": f"{error}\n{traceback.format_exc(limit=3)}",
            })
