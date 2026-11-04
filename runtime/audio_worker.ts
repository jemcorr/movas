/// <reference no-default-lib="true" />
/// <reference lib="deno.worker" />
// The mix in its own thread. It runs from compile time, beside the page, the plan and the encoders, so its arithmetic never
// holds up the frame pipe on the main thread. Same steps and same order as the mix used to run after the frames.
import { mix } from "./mix.ts";

self.onmessage = async (e: MessageEvent) => {
  const { solved, mixOpts, f32, out, bitrate, samples } = e.data;
  try {
    const { sum, L } = await mix(solved, mixOpts);
    await Deno.writeFile(f32, new Uint8Array(sum.buffer));
    const p = await new Deno.Command("ffmpeg", { args: ["-v", "error", "-nostdin", "-y", "-f", "f32le", "-ar", "48000", "-ac", "2", "-i", f32, "-c:a", "aac_at", "-b:a", bitrate, out], stderr: "piped" }).output();
    if (!p.success) throw new Error(new TextDecoder().decode(p.stderr));
    if (L !== samples) throw new Error(`mix length ${L} is not the expected ${samples}`);
    self.postMessage({ ok: true });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err as Error)?.stack ?? err) });
  }
};
