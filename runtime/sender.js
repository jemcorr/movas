// Runs as the page's frame sender, in a worker. Blink pumps a large WebSocket message into the network service from the
// thread that sent it, a slice each time the pipe drains. On the page's main thread those slices waited behind every
// draw and readback, so the transfer ran in lockstep with the drawing. Here they run on a thread of their own.
// Each frame arrives as a transferred buffer. send() copies it, so the buffer goes straight back to the page for the next frame.
const ws = new WebSocket(`ws://${location.host}/frames`);
ws.binaryType = "arraybuffer";
const open = new Promise((resolve) => (ws.onopen = resolve));
ws.onerror = () => postMessage({ error: "the frame socket failed" });
// A closed socket drops what it is sent without an error, and the page would wait for acks until the render times out.
ws.onclose = () => postMessage({ error: "the frame socket closed" });
onmessage = async (e) => {
  await open;
  ws.send(e.data);
  postMessage(e.data, [e.data]);
};
