import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkVideoAccessible, probeVideo } from "../../lib/ffprobe";

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

beforeAll(() => {
	multiAudioFixtureDir = mkdtempSync(join(tmpdir(), "cap-media-server-ffprobe-"));
	const multiAudioVideoPath = join(multiAudioFixtureDir, "test-multi-audio.mp4");
	createMultiAudioTestVideo(multiAudioVideoPath);
	multiAudioVideoUrl = `file://${multiAudioVideoPath}`;
});

afterAll(() => {
	if (multiAudioFixtureDir) {
		rmSync(multiAudioFixtureDir, { recursive: true, force: true });
	}
});

describe("ffprobe integration tests", () => {
	describe("probeVideo", () => {
		test("extracts metadata from video with audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

			expect(metadata).toHaveProperty("duration");
			expect(metadata).toHaveProperty("width");
			expect(metadata).toHaveProperty("height");
			expect(metadata).toHaveProperty("fps");
			expect(metadata).toHaveProperty("videoCodec");
			expect(metadata).toHaveProperty("audioCodec");
			expect(metadata).toHaveProperty("audioChannels");
			expect(metadata).toHaveProperty("sampleRate");
			expect(metadata).toHaveProperty("bitrate");
			expect(metadata).toHaveProperty("fileSize");

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).not.toBeNull();
		});

		test("extracts metadata from video without audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_NO_AUDIO);

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).toBeNull();
			expect(metadata.audioChannels).toBeNull();
			expect(metadata.sampleRate).toBeNull();
		});

		test("throws error for non-existent video", async () => {
			await expect(
				probeVideo("file:///nonexistent/path/to/video.mp4"),
			).rejects.toThrow();
		});

		test("throws error for invalid URL", async () => {
			await expect(
				probeVideo(
					"https://invalid-domain-that-does-not-exist.example/video.mp4",
				),
			).rejects.toThrow();
		});

		test("prefers the highest-bitrate audio stream when multiple tracks exist", async () => {
			const metadata = await probeVideo(multiAudioVideoUrl);

			expect(metadata.audioCodec).toBe("aac");
			expect(metadata.audioChannels).toBe(1);
			expect(metadata.sampleRate).toBe(48000);
		});
	});

	describe("checkVideoAccessible", () => {
		test("returns false for non-existent http URL", async () => {
			const accessible = await checkVideoAccessible(
				"https://invalid-domain-that-does-not-exist.example/video.mp4",
			);
			expect(accessible).toBe(false);
		});
	});
});

describe("ffprobe metadata accuracy", () => {
	test("returns correct frame rate format", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(typeof metadata.fps).toBe("number");
		expect(metadata.fps).toBeLessThanOrEqual(240);
		expect(metadata.fps % 1).toBeLessThanOrEqual(0.01);
	});

	test("returns reasonable dimensions", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.width).toBeLessThanOrEqual(4096);
		expect(metadata.height).toBeLessThanOrEqual(4096);
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	test("duration matches expected range for test file", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.duration).toBeGreaterThan(0);
		expect(metadata.duration).toBeLessThan(3600);
	});
});
