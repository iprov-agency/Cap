import { downsampleTo16kHz, encodeWav } from "./audio-pcm";

const MAX_STREAMING_DURATION_MS = 10 * 60 * 1000;

interface StreamingTranscriptionHandle {
	start: (stream: MediaStream) => void;
	stop: () => Promise<void>;
	isActive: () => boolean;
}

export function createStreamingTranscription(
	videoId: string,
): StreamingTranscriptionHandle {
	let audioContext: AudioContext | null = null;
	let scriptProcessor: ScriptProcessorNode | null = null;
	let sourceNode: MediaStreamAudioSourceNode | null = null;
	let gainNode: GainNode | null = null;
	let active = false;
	const chunks: Float32Array[] = [];
	let inputSampleRate = 48000;
	let totalSamplesAccumulated = 0;
	let maxSamplesReached = false;

	const start = (stream: MediaStream) => {
		const audioTracks = stream.getAudioTracks();
		if (audioTracks.length === 0) {
			return;
		}

		try {
			audioContext = new AudioContext();
			inputSampleRate = audioContext.sampleRate;

			const maxSamplesAllowed = Math.ceil(
				(inputSampleRate * MAX_STREAMING_DURATION_MS) / 1000,
			);

			audioContext.resume().catch(() => {});

			const audioOnlyStream = new MediaStream(audioTracks);
			sourceNode = audioContext.createMediaStreamSource(audioOnlyStream);

			scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);
			scriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
				if (!active || maxSamplesReached) return;
				const inputData = event.inputBuffer.getChannelData(0);
				totalSamplesAccumulated += inputData.length;
				if (totalSamplesAccumulated > maxSamplesAllowed) {
					maxSamplesReached = true;
					return;
				}
				chunks.push(new Float32Array(inputData));
			};

			sourceNode.connect(scriptProcessor);
			gainNode = audioContext.createGain();
			gainNode.gain.value = 0;
			scriptProcessor.connect(gainNode);
			gainNode.connect(audioContext.destination);
			active = true;
		} catch (err) {
			console.error("Failed to start streaming audio extraction", err);
			cleanup();
		}
	};

	const cleanup = () => {
		active = false;
		if (scriptProcessor) {
			scriptProcessor.disconnect();
			scriptProcessor = null;
		}
		if (gainNode) {
			gainNode.disconnect();
			gainNode = null;
		}
		if (sourceNode) {
			sourceNode.disconnect();
			sourceNode = null;
		}
		if (audioContext && audioContext.state !== "closed") {
			audioContext.close().catch(() => {});
			audioContext = null;
		}
	};

	const stop = async () => {
		if (!active && chunks.length === 0) {
			cleanup();
			return;
		}

		cleanup();

		if (chunks.length === 0) {
			return;
		}

		try {
			let totalLength = 0;
			for (const chunk of chunks) {
				totalLength += chunk.length;
			}

			const merged = new Float32Array(totalLength);
			let offset = 0;
			for (const chunk of chunks) {
				merged.set(chunk, offset);
				offset += chunk.length;
			}

			const downsampled = await downsampleTo16kHz(merged, inputSampleRate);
			const wavBuffer = encodeWav(downsampled, 16000);

			const response = await fetch("/api/transcribe-stream", {
				method: "POST",
				headers: {
					"Content-Type": "audio/wav",
					"X-Video-Id": videoId,
				},
				body: wavBuffer,
			});

			if (!response.ok) {
				console.error(
					"Streaming transcription request failed:",
					response.status,
					await response.text().catch(() => ""),
				);
			}
		} catch (err) {
			console.error("Failed to send streaming transcription", err);
		}
	};

	const isActive = () => active;

	return { start, stop, isActive };
}
