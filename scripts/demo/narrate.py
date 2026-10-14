"""Generate submission narration locally without sending project data to an API."""

import json
import subprocess
import sys
import wave
from pathlib import Path

from piper import PiperVoice, SynthesisConfig


def render(story_path: Path, model_path: Path, output_path: Path) -> None:
    """Render one audio file per named demonstration beat.

    Args:
        story_path: JSON containing the ordered narration beats.
        model_path: Local Piper voice model.
        output_path: Directory for audio and measured duration metadata.
    """
    beats = json.loads(story_path.read_text())
    output_path.mkdir(parents=True, exist_ok=True)
    voice = PiperVoice.load(str(model_path))
    config = SynthesisConfig(length_scale=1.05)
    durations = {}
    for beat in beats:
        audio_path = output_path / (beat["id"] + ".wav")
        text = beat["narration"].replace("KLoCGit", "Clock it")
        source_path = audio_path.with_suffix(".source.wav")
        with wave.open(str(source_path), "wb") as audio:
            voice.synthesize_wav(text, audio, syn_config=config)
        # Keep a clear demo pace without altering the narrator's pitch.
        subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i",
             str(source_path), "-af", "atempo=1.2", str(audio_path)],
            check=True, timeout=30,
        )
        source_path.unlink()
        with wave.open(str(audio_path), "rb") as audio:
            durations[beat["id"]] = audio.getnframes() / audio.getframerate()
    (output_path / "durations.json").write_text(json.dumps(durations))
    print(json.dumps({"narration_seconds": sum(durations.values()), "beats": len(beats)}))


if __name__ == "__main__":
    render(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3]))
