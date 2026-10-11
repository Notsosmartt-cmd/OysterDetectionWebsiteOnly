// MediaRecorder writes a "live stream" style file: fragmented MP4 (or WebM) without a duration or a seek index.
// Players such as Windows Movies & TV then show no usable timeline. Rewriting the container (no re-encoding,
// so it is fast and lossless) gives a normal file with a known length and a working slider.

/**
 * @param {Blob} blob recording produced by MediaRecorder
 * @returns {Promise<Blob>} seekable copy, or the original blob if anything goes wrong
 */
export const makeSeekable = async (blob) => {
  try {
    // loaded on demand: only people who record a video download this code
    const { Input, Output, BlobSource, BufferTarget, Mp4OutputFormat, WebMOutputFormat, Conversion, MP4, WEBM } =
      await import("mediabunny");

    const isMp4 = blob.type.includes("mp4");
    // only the two formats MediaRecorder can produce, so the rest of the library is left out of the bundle
    const input = new Input({ source: new BlobSource(blob), formats: [MP4, WEBM] });
    const output = new Output({
      // 'in-memory': the index (moov) is written at the start of the file, so players can seek right away
      format: isMp4 ? new Mp4OutputFormat({ fastStart: "in-memory" }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });

    const conversion = await Conversion.init({ input, output });
    if (!conversion.isValid) {
      throw new Error(`conversion not possible (${conversion.discardedTracks.map((t) => t.reason).join(", ")})`);
    }
    await conversion.execute();

    return new Blob([output.target.buffer], { type: isMp4 ? "video/mp4" : "video/webm" });
  } catch (err) {
    console.warn("Could not make the recording seekable, using the original file:", err);
    return blob;
  }
};
