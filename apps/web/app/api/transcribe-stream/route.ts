import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { s3Buckets, videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { S3Buckets } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import type { NextRequest } from "next/server";
import { GEMINI_AUDIO_MODEL, getGeminiClient } from "@/lib/gemini-client";
import { runPromise } from "@/lib/server";
import { geminiTextToWebVTT } from "@/lib/transcribe-utils";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

function isValidWavHeader(buffer: ArrayBuffer): boolean {
	if (buffer.byteLength < 12) return false;
	const view = new DataView(buffer);
	const riff =
		String.fromCharCode(view.getUint8(0)) +
		String.fromCharCode(view.getUint8(1)) +
		String.fromCharCode(view.getUint8(2)) +
		String.fromCharCode(view.getUint8(3));
	const wave =
		String.fromCharCode(view.getUint8(8)) +
		String.fromCharCode(view.getUint8(9)) +
		String.fromCharCode(view.getUint8(10)) +
		String.fromCharCode(view.getUint8(11));
	return riff === "RIFF" && wave === "WAVE";
}

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("audio/wav")) {
		return Response.json(
			{ error: "Invalid content-type, expected audio/wav" },
			{ status: 400 },
		);
	}

	const videoId = request.headers.get("X-Video-Id");
	if (!videoId) {
		return Response.json(
			{ error: "Missing X-Video-Id header" },
			{ status: 400 },
		);
	}

	if (!serverEnv().GOOGLE_API_KEY) {
		return Response.json(
			{ error: "Transcription not configured" },
			{ status: 503 },
		);
	}

	const query = await db()
		.select({
			video: videos,
			bucket: s3Buckets,
		})
		.from(videos)
		.leftJoin(s3Buckets, eq(videos.bucket, s3Buckets.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const video = query[0].video;
	if (video.ownerId !== user.id) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const audioBuffer = await request.arrayBuffer();
	if (audioBuffer.byteLength === 0) {
		return Response.json({ error: "Empty audio body" }, { status: 400 });
	}

	if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
		return Response.json({ error: "Audio payload too large" }, { status: 413 });
	}

	if (!isValidWavHeader(audioBuffer)) {
		return Response.json({ error: "Invalid WAV file format" }, { status: 400 });
	}

	try {
		const gemini = getGeminiClient();
		if (!gemini) {
			return Response.json(
				{ error: "Gemini client not available" },
				{ status: 503 },
			);
		}

		await db()
			.update(videos)
			.set({ transcriptionStatus: "PROCESSING" })
			.where(eq(videos.id, videoId as Video.VideoId));

		const audioBase64 = Buffer.from(audioBuffer).toString("base64");

		const model = gemini.getGenerativeModel({ model: GEMINI_AUDIO_MODEL });

		const result = await model.generateContent([
			{
				inlineData: {
					mimeType: "audio/wav",
					data: audioBase64,
				},
			},
			{
				text: `Transcribe this audio accurately. Include timestamps for each segment.
Format each line as: [MM:SS] transcribed text
For example:
[0:00] Hello and welcome to this video.
[0:05] Today we're going to talk about...

Be precise with the timestamps and transcribe every word spoken. If there are multiple speakers, note speaker changes.`,
			},
		]);

		const transcriptionText = result.response.text();

		if (!transcriptionText || transcriptionText.trim().length === 0) {
			return Response.json(
				{ error: "Gemini returned empty transcription" },
				{ status: 502 },
			);
		}

		const vtt = geminiTextToWebVTT(transcriptionText);

		const [bucket] = await S3Buckets.getBucketAccess(
			Option.fromNullable(query[0].bucket?.id),
		).pipe(runPromise);

		await bucket
			.putObject(`${user.id}/${videoId}/transcription.vtt`, vtt, {
				contentType: "text/vtt",
			})
			.pipe(runPromise);

		await db()
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, videoId as Video.VideoId));

		return Response.json({ success: true });
	} catch (err) {
		console.error(
			`[transcribe-stream] Failed to transcribe video ${videoId}:`,
			err,
		);
		return Response.json({ error: "Transcription failed" }, { status: 500 });
	}
}
