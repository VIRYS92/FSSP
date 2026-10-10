const intervalMs = 30_000;

console.log("fssp-control worker bootstrap: import queue is not implemented yet");
console.log(`worker heartbeat interval: ${intervalMs}ms`);

const heartbeat = setInterval(() => {
  console.log("fssp-control worker heartbeat: idle");
}, intervalMs);

const stop = () => {
  clearInterval(heartbeat);
  process.exit(0);
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
