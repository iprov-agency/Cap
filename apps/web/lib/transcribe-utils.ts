export interface DeepgramWord {
	word: string;
	punctuated_word: string;
	start: number;
	end: number;
	confidence?: number;
}

export interface DeepgramUtterance {
	words: DeepgramWord[];
	transcript?: string;
	start?: number;
	end?: number;
	confidence?: number;
}

export interface DeepgramResult {
	results: {
		utterances: DeepgramUtterance[] | null;
	};
}

export function formatTimestamp(seconds: number): string {
	const date = new Date(seconds * 1000);
	const hours = date.getUTCHours().toString().padStart(2, "0");
	const minutes = date.getUTCMinutes().toString().padStart(2, "0");
	const secs = date.getUTCSeconds().toString().padStart(2, "0");
	const millis = (date.getUTCMilliseconds() / 1000).toFixed(3).slice(2, 5);

	return `${hours}:${minutes}:${secs}.${millis}`;
}

export function formatToWebVTT(result: DeepgramResult): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;

	if (!result.results.utterances || result.results.utterances.length === 0) {
		return output;
	}

	for (const utterance of result.results.utterances) {
		const words = utterance.words;
		if (!words || words.length === 0) continue;

		let group: string[] = [];
		let start = formatTimestamp(words[0]?.start ?? 0);
		let wordCount = 0;

		for (let i = 0; i < words.length; i++) {
			const word = words[i];
			if (!word) continue;

			group.push(word.punctuated_word);
			wordCount++;

			const nextWord = words[i + 1];
			const shouldBreak =
				word.punctuated_word.endsWith(",") ||
				word.punctuated_word.endsWith(".") ||
				(nextWord && nextWord.start - word.end > 0.5) ||
				wordCount === 8;

			if (shouldBreak) {
				const end = formatTimestamp(word.end);
				const groupText = group.join(" ");

				output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
				captionIndex++;

				group = [];
				start = nextWord ? formatTimestamp(nextWord.start) : start;
				wordCount = 0;
			}
		}

		if (group.length > 0) {
			const lastWord = words[words.length - 1];
			if (lastWord) {
				const end = formatTimestamp(lastWord.end);
				const groupText = group.join(" ");
				output += `${captionIndex}\n${start} --> ${end}\n${groupText}\n\n`;
				captionIndex++;
			}
		}
	}

	return output;
}

/**
 * Convert Gemini transcription text response to WebVTT format.
 * Gemini returns text with timestamp markers like [00:00] or (0:00).
 * We parse these into proper VTT cues.
 */
export function geminiTextToWebVTT(text: string): string {
	let output = "WEBVTT\n\n";
	let captionIndex = 1;

	// Try to parse timestamped lines from Gemini output
	// Common formats: [00:00] text, (0:00) text, 00:00 - text, [00:00:00] text
	const lines = text.split("\n").filter((l) => l.trim());

	const timePattern =
		/(?:\[|$$)?(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\]|$$)?[\s\-:]*(.+)/;

	interface ParsedSegment {
		startSeconds: number;
		text: string;
	}

	const segments: ParsedSegment[] = [];

	for (const line of lines) {
		const match = line.match(timePattern);
		if (match) {
			const hours = match[3] ? parseInt(match[1] ?? "0", 10) : 0;
			const minutes = match[3]
				? parseInt(match[2] ?? "0", 10)
				: parseInt(match[1] ?? "0", 10);
			const seconds = match[3]
				? parseInt(match[3], 10)
				: parseInt(match[2] ?? "0", 10);
			const startSeconds = hours * 3600 + minutes * 60 + seconds;
			const segmentText = (match[4] ?? "").trim();
			if (segmentText) {
				segments.push({ startSeconds, text: segmentText });
			}
		}
	}

	// If no timestamps found, treat the whole text as a single cue
	if (segments.length === 0 && text.trim()) {
		output += `1\n00:00:00.000 --> 99:59:59.000\n${text.trim()}\n\n`;
		return output;
	}

	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (!segment) continue;
		const nextSegment = segments[i + 1];
		const endSeconds = nextSegment
			? nextSegment.startSeconds
			: segment.startSeconds + 5;

		const startTs = formatTimestamp(segment.startSeconds);
		const endTs = formatTimestamp(endSeconds);

		output += `${captionIndex}\n${startTs} --> ${endTs}\n${segment.text}\n\n`;
		captionIndex++;
	}

	return output;
}
