import { describe, expect, test } from "bun:test";
import {
	type FFprobeStream,
	selectPreferredAudioStreamIndex,
} from "../../lib/ffprobe";

describe("selectPreferredAudioStreamIndex", () => {
	test("returns the highest bitrate audio stream index relative to audio streams", () => {
		const streams: FFprobeStream[] = [
			{ codec_type: "video", codec_name: "h264" },
			{ codec_type: "audio", codec_name: "aac", bit_rate: "2200" },
			{ codec_type: "audio", codec_name: "aac", bit_rate: "65014" },
		];

		expect(selectPreferredAudioStreamIndex(streams)).toBe(1);
	});

	test("returns null when there are zero or one audio streams", () => {
		expect(
			selectPreferredAudioStreamIndex([
				{ codec_type: "video", codec_name: "h264" },
			]),
		).toBeNull();
		expect(
			selectPreferredAudioStreamIndex([
				{ codec_type: "video", codec_name: "h264" },
				{ codec_type: "audio", codec_name: "aac", bit_rate: "65014" },
			]),
		).toBeNull();
	});

	test("returns null when multiple audio streams do not expose usable bitrates", () => {
		const streams: FFprobeStream[] = [
			{ codec_type: "video", codec_name: "h264" },
			{ codec_type: "audio", codec_name: "aac" },
			{ codec_type: "audio", codec_name: "aac", bit_rate: "not-a-number" },
		];

		expect(selectPreferredAudioStreamIndex(streams)).toBeNull();
	});
});
