// A stand-in for opener-worker.mjs: answers "ok:<text>", except "die" (the thread exits),
// "hang" (never answers) and "throw" (an uncaught error).
import { parentPort } from 'node:worker_threads'
parentPort.on('message', ({ id, sealed }) => {
  if (sealed === 'die') process.exit(1)
  if (sealed === 'hang') return
  if (sealed === 'throw') throw new Error('boom')
  parentPort.postMessage({ id, pt: `ok:${sealed}` })
})
