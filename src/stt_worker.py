#!/usr/bin/env python3
import json
import os
import sys

from faster_whisper import WhisperModel


def emit(message):
    sys.stdout.write(json.dumps(message) + "\n")
    sys.stdout.flush()


def main():
    model_name = os.getenv("STT_MODEL", "distil-small.en")
    compute_type = os.getenv("STT_COMPUTE_TYPE", "int8")
    cpu_threads = int(os.getenv("STT_CPU_THREADS", "4"))

    try:
        model = WhisperModel(
            model_name,
            device="cpu",
            compute_type=compute_type,
            cpu_threads=cpu_threads,
        )
    except Exception as err:
        emit({"type": "ready", "error": f"failed to load model: {err}"})
        return

    emit({"type": "ready", "model": model_name})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            req = json.loads(line)
            request_id = req.get("id")
            audio_path = req.get("audioPath")
            if not request_id or not audio_path:
                emit({"id": request_id, "error": "missing id or audioPath"})
                continue

            segments, _ = model.transcribe(
                audio_path,
                language="en",
                beam_size=1,
                best_of=1,
                temperature=0.0,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join((segment.text or "").strip() for segment in segments).strip()
            emit({"id": request_id, "text": text})
        except Exception as err:
            emit({"id": request_id, "error": str(err)})


if __name__ == "__main__":
    main()
