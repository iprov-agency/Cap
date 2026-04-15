import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkHasAudioTrack,
	extractAudio,
	extractAudioStream,
} from "../../lib/ffmpeg";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;
let multiAudioFixtureDir: string;
let multiAudioVideoUrl: string;

function createMultiAudioTestVideo(outputPath: string): void {
	execFileSync("ffmpeg", [
		"-y",
		"-f",
		"lavfi",
		"-i",
		"color=c=black:s=320x240:d=2:r=30",
		"-f",
		"lavfi",
		"-i",
		"anullsrc=channel_layout=stereo:sample_rate=48000",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=1000:duration=2:sample_rate=48000",
		"-map",
		"0:v:0",
		"-map",
		"1:a:0",
		"-map",
		"2:a:0",
		"-c:v",
		"libx264",
		"-pix_fmt",
		"yuv420p",
		"-shortest",
		"-c:a:0",
		"aac",
		"-b:a:0",
		"8k",
		"-ac:a:0",
		"2",
		"-c:a:1",
		"aac",
		"-b:a:1",
		"64k",
		"-ac:a:1",
		"1",
		outputPath,
	]);
}

function getMeanVolume(audioPath: string): number {
	const result = spawnSync(
		"ffmpeg",
		["-i", audioPath, "-af", "volumedetect", "-f", "null", "-"],
		{ encoding: "utf8" },
	);
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	const match = output.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);

	if (match?.[1]) {
		return Number.parseFloat(match[1]);
	}

	if (output.includes("mean_volume: -inf dB")) {
		return Number.NEGATIVE_INFINITY;
	}

	throw new Error(`Could not determine mean volume for ${audioPath}`);
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	const chunks: Uint8Array[] = [];
	let totalLength = 0;
	const reader = stream.getReader();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
			totalLength += value.length;
		}
	} finally {
		reader.releaseLock();
	}

	const output = new Uint8Array(totalLength);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.length;
	}

	return output;
}

beforeAll(() => {
	multiAudioFixtureDir = mkdtempSync(join(tmpdir(), "cap-media-server-ffmpeg-"));
	const multiAudioVideoPath = join(multiAudioFixtureDir, "test-multi-audio.mp4");
	createMultiAudioTestVideo(multiAudioVideoPath);
	multiAudioVideoUrl = `file://${multiAudioVideoPath}`;
});

afterAll(() => {
	if (multiAudioFixtureDir) {
		rmSync(multiAudioFixtureDir, { recursive: true, force: true });
	}
});

describe("ffmpeg integration tests", () => {
	describe("checkHasAudioTrack", () => {
		test("detects audio track in video with audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_WITH_AUDIO);
			expect(hasAudio).toBe(true);
		});

		test("detects no audio track in video without audio", async () => {
			const hasAudio = await checkHasAudioTrack(TEST_VIDEO_NO_AUDIO);
			expect(hasAudio).toBe(false);
		});
	});

	describe("extractAudio", () => {
		test("extracts audio from video with audio track", async () => {
			const audioData = await extractAudio(TEST_VIDEO_WITH_AUDIO);

			expect(audioData).toBeInstanceOf(Uint8Array);
			expect(audioData.length).toBeGreaterThan(0);

			const hasId3Tag =
				audioData[0] === 0x49 && audioData[1] === 0x44 && audioData[2] === 0x33;
			const hasMpegSync =
				audioData[0] === 0xff && (audioData[1] & 0xe0) === 0xe0;
			expect(hasId3Tag || hasMpegSync).toBe(true);
		});

		test("throws error for video without audio track", async () => {
			await expect(extractAudio(TEST_VIDEO_NO_AUDIO)).rejects.toThrow();
		});

		test(
			"extracts the highest-bitrate audio track when multiple audio streams exist",
			async () => {
				const audioData = await extractAudio(multiAudioVideoUrl);
				const extractedAudioPath = join(
					multiAudioFixtureDir,
					"multi-audio-extracted.mp3",
				);

				writeFileSync(extractedAudioPath, audioData);

				expect(getMeanVolume(extractedAudioPath)).toBeGreaterThan(-60);
			},
			120000,
		);
	});

	describe("extractAudioStream", () => {
		test(
			"streams the highest-bitrate audio track when multiple audio streams exist",
			async () => {
				const { stream } = extractAudioStream(multiAudioVideoUrl);
				const streamedAudio = await readAll(stream);
				const streamedAudioPath = join(
					multiAudioFixtureDir,
					"multi-audio-streamed.mp3",
				);

				writeFileSync(streamedAudioPath, streamedAudio);

				expect(getMeanVolume(streamedAudioPath)).toBeGreaterThan(-60);
			},
			120000,
		);
	});
});
