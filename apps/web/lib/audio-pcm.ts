export async function downsampleTo16kHz(
	buffer: Float32Array,
	inputSampleRate: number,
): Promise<Float32Array> {
	if (inputSampleRate === 16000) {
		return buffer;
	}

	const offlineCtx = new OfflineAudioContext(
		1,
		Math.ceil((buffer.length * 16000) / inputSampleRate),
		16000,
	);
	const source = offlineCtx.createBufferSource();
	const audioBuffer = offlineCtx.createBuffer(
		1,
		buffer.length,
		inputSampleRate,
	);
	audioBuffer.getChannelData(0).set(buffer);
	source.buffer = audioBuffer;
	source.connect(offlineCtx.destination);
	source.start();
	const rendered = await offlineCtx.startRendering();
	return rendered.getChannelData(0);
}

export function floatTo16BitPCM(float32Array: Float32Array): ArrayBuffer {
	const buffer = new ArrayBuffer(float32Array.length * 2);
	const view = new DataView(buffer);

	for (let i = 0; i < float32Array.length; i++) {
		const sample = float32Array[i] ?? 0;
		const clamped = Math.max(-1, Math.min(1, sample));
		const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
		view.setInt16(i * 2, int16, true);
	}

	return buffer;
}

export function encodeWav(
	pcmData: Float32Array,
	sampleRate: number,
): ArrayBuffer {
	const pcm16 = floatTo16BitPCM(pcmData);
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataSize = pcm16.byteLength;
	const headerSize = 44;
	const totalSize = headerSize + dataSize;

	const buffer = new ArrayBuffer(totalSize);
	const view = new DataView(buffer);

	writeString(view, 0, "RIFF");
	view.setUint32(4, totalSize - 8, true);
	writeString(view, 8, "WAVE");

	writeString(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, byteRate, true);
	view.setUint16(32, blockAlign, true);
	view.setUint16(34, bitsPerSample, true);

	writeString(view, 36, "data");
	view.setUint32(40, dataSize, true);

	const pcmBytes = new Uint8Array(pcm16);
	const wavBytes = new Uint8Array(buffer);
	wavBytes.set(pcmBytes, headerSize);

	return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
