// Wire protocol shared by client and server.
// Every frame is binary: varUint(type) followed by varUint8Array(payload).
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

export const MSG = Object.freeze({
  SYNC_STEP1: 0, // payload: state vector (what I have)
  SYNC_STEP2: 1, // payload: update containing what you are missing
  UPDATE: 2, // payload: incremental update
  AWARENESS: 3, // payload: awareness (presence) update
  ERROR: 4, // payload: utf8 JSON { code, message }
  PING: 5,
  PONG: 6,
  READ_ONLY: 7, // server tells the client it cannot write
})

export const MSG_NAME = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]))

export const MAX_FRAME_BYTES = 8 * 1024 * 1024

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function encodeMessage(type, payload = new Uint8Array(0)) {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, type)
  encoding.writeVarUint8Array(enc, payload)
  return encoding.toUint8Array(enc)
}

export function decodeMessage(buf) {
  const data = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const dec = decoding.createDecoder(data)
  const type = decoding.readVarUint(dec)
  const payload = decoding.readVarUint8Array(dec)
  return { type, payload }
}

export const encodeJSON = (obj) => textEncoder.encode(JSON.stringify(obj))
export const decodeJSON = (bytes) => JSON.parse(textDecoder.decode(bytes))

export const errorMessage = (code, message) => encodeMessage(MSG.ERROR, encodeJSON({ code, message }))
